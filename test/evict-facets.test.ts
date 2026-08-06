import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AuditEntry,
  CompressedObservation,
  Facet,
  Memory,
  Session,
} from "../src/types.js";
import { registerEvictFunction } from "../src/functions/evict.js";
import { getSearchIndex, setIndexPersistence } from "../src/functions/search.js";
import { KV } from "../src/state/schema.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Same gate as test/evict.test.ts: keyless installs skip the recovered-session
// consolidation pass, force it on so behaviour does not depend on env.
vi.mock("../src/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config.js")>()),
  isConsolidationEnabled: () => true,
}));

type Store = Map<string, Map<string, unknown>>;
type Handler = (payload: unknown) => unknown | Promise<unknown>;

const SESSION_ID = "ses_evict_facets";

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function mockKV(store: Store, listCalls: Map<string, number>) {
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      listCalls.set(scope, (listCalls.get(scope) ?? 0) + 1);
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    sdk: {
      registerFunction: (functionId: string, handler: Handler) => {
        handlers.set(functionId, handler);
      },
      trigger: async (input: { function_id: string; payload: unknown }) => {
        const handler = handlers.get(input.function_id);
        if (!handler) throw new Error(`missing handler: ${input.function_id}`);
        return handler(input.payload);
      },
    },
  };
}

// Young enough that the stale-session branch never fires: the observation and
// memory branches are what this suite exercises (the stale-session case builds
// its own store below).
function freshSession(): Session {
  return {
    id: SESSION_ID,
    project: "agentmemory",
    cwd: "/repo/agentmemory",
    startedAt: daysAgo(1),
    status: "active",
    observationCount: 2,
  };
}

function makeObservation(
  id: string,
  overrides: Partial<CompressedObservation> = {},
): CompressedObservation {
  return {
    id,
    sessionId: SESSION_ID,
    timestamp: daysAgo(1),
    type: "decision",
    title: `observation ${id}`,
    facts: [`fact about ${id}`],
    narrative: `narrative about ${id}`,
    concepts: ["sqlite"],
    files: ["src/state/kv.ts"],
    importance: 9,
    ...overrides,
  };
}

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "mem_1",
    createdAt: daysAgo(1),
    updatedAt: daysAgo(1),
    type: "fact",
    title: "memory title",
    content: "memory content about sqlite storage",
    concepts: ["sqlite"],
    files: ["src/state/kv.ts"],
    sessionIds: [SESSION_ID],
    strength: 5,
    version: 1,
    isLatest: true,
    ...overrides,
  };
}

// Our own memories carry four dimensions (service/stage/wave/feature), which is
// what the cascade has to clear in one go.
const DIMENSIONS = ["service", "stage", "wave", "feature"];

function facetsFor(
  targetId: string,
  targetType: Facet["targetType"],
  dimensions: string[] = DIMENSIONS,
): Facet[] {
  return dimensions.map((dimension) => ({
    id: `fct_${targetId}_${dimension}`,
    targetId,
    targetType,
    dimension,
    value: `${dimension}-value`,
    createdAt: daysAgo(1),
  }));
}

interface Fixture {
  observations?: CompressedObservation[];
  memories?: Memory[];
  facets?: Facet[];
  maxObservationsPerProject?: number;
}

function makeStore(fixture: Fixture): Store {
  const session = freshSession();
  const config = new Map<string, unknown>();
  if (fixture.maxObservationsPerProject !== undefined) {
    config.set("eviction", {
      maxObservationsPerProject: fixture.maxObservationsPerProject,
    });
  }
  return new Map<string, Map<string, unknown>>([
    [KV.sessions, new Map([[session.id, session]])],
    [KV.summaries, new Map()],
    [
      KV.observations(session.id),
      new Map((fixture.observations ?? []).map((o) => [o.id, o])),
    ],
    [KV.memories, new Map((fixture.memories ?? []).map((m) => [m.id, m]))],
    [KV.facets, new Map((fixture.facets ?? []).map((f) => [f.id, f]))],
    [KV.config, config],
    [KV.audit, new Map()],
    [KV.accessLog, new Map()],
  ]);
}

interface Harness {
  run: () => Promise<EvictStats>;
  store: Store;
  listCalls: Map<string, number>;
}

interface EvictStats {
  staleSessions: number;
  lowImportanceObs: number;
  capEvictions: number;
  expiredMemories: number;
  nonLatestMemories: number;
  facetsRemoved: number;
  dryRun: boolean;
}

function runEvictOn(store: Store, payload: { dryRun?: boolean } = {}): Harness {
  const listCalls = new Map<string, number>();
  const kv = mockKV(store, listCalls);
  const { sdk } = mockSdk();
  registerEvictFunction(sdk as never, kv as never);
  setIndexPersistence({ scheduleSave: vi.fn(), save: vi.fn(async () => {}) });
  return {
    store,
    listCalls,
    run: () =>
      sdk.trigger({
        function_id: "mem::evict",
        payload,
      }) as Promise<EvictStats>,
  };
}

function runEvict(
  fixture: Fixture,
  payload: { dryRun?: boolean } = {},
): Harness {
  return runEvictOn(makeStore(fixture), payload);
}

function facetIds(store: Store): string[] {
  return Array.from(store.get(KV.facets)!.keys()).sort();
}

function auditRows(store: Store): AuditEntry[] {
  return Array.from(store.get(KV.audit)!.values()) as AuditEntry[];
}

describe("mem::evict facet cascade", () => {
  beforeEach(() => {
    getSearchIndex().clear();
    setIndexPersistence(null);
  });

  afterEach(() => {
    getSearchIndex().clear();
    setIndexPersistence(null);
  });

  it("removes the facets of a TTL-expired memory", async () => {
    const expired = makeMemory({
      id: "mem_expired",
      forgetAfter: "2020-01-01T00:00:00Z",
    });
    const { run, store } = runEvict({
      memories: [expired],
      facets: facetsFor("mem_expired", "memory"),
    });
    expect(facetIds(store)).toHaveLength(4);

    const stats = await run();

    expect(stats.expiredMemories).toBe(1);
    expect(stats.facetsRemoved).toBe(4);
    expect(facetIds(store)).toEqual([]);
  });

  it("removes the facets of an evicted non-latest memory", async () => {
    const stale = makeMemory({
      id: "mem_non_latest",
      isLatest: false,
      createdAt: daysAgo(200),
      updatedAt: daysAgo(200),
    });
    const { run, store } = runEvict({
      memories: [stale],
      facets: facetsFor("mem_non_latest", "memory"),
    });

    const stats = await run();

    expect(stats.nonLatestMemories).toBe(1);
    expect(stats.facetsRemoved).toBe(4);
    expect(facetIds(store)).toEqual([]);
  });

  it("leaves the facets of a surviving memory alone", async () => {
    const expired = makeMemory({
      id: "mem_expired",
      forgetAfter: "2020-01-01T00:00:00Z",
    });
    const kept = makeMemory({ id: "mem_kept" });
    const { run, store } = runEvict({
      memories: [expired, kept],
      facets: [
        ...facetsFor("mem_expired", "memory"),
        ...facetsFor("mem_kept", "memory"),
      ],
    });

    const stats = await run();

    expect(stats.expiredMemories).toBe(1);
    expect(stats.facetsRemoved).toBe(4);
    // Positive control: a cascade keyed on the wrong id (or a blanket wipe of
    // the namespace) would take these four down as well.
    expect(facetIds(store)).toEqual(
      facetsFor("mem_kept", "memory")
        .map((f) => f.id)
        .sort(),
    );
  });

  it("counts but does not delete facets on dryRun", async () => {
    const expired = makeMemory({
      id: "mem_expired",
      forgetAfter: "2020-01-01T00:00:00Z",
    });
    const low = makeObservation("obs_low", {
      importance: 1,
      timestamp: daysAgo(200),
    });
    const { run, store } = runEvict(
      {
        memories: [expired],
        observations: [low],
        facets: [
          ...facetsFor("mem_expired", "memory"),
          ...facetsFor("obs_low", "observation", ["service"]),
        ],
      },
      { dryRun: true },
    );

    const stats = await run();

    expect(stats.dryRun).toBe(true);
    expect(stats.expiredMemories).toBe(1);
    expect(stats.lowImportanceObs).toBe(1);
    expect(stats.facetsRemoved).toBe(5);
    expect(facetIds(store)).toHaveLength(5);
    expect(
      auditRows(store).filter((a) => a.details?.resource === "facet"),
    ).toHaveLength(0);
  });

  it("removes the facets of a cap-evicted observation", async () => {
    const low = makeObservation("obs_low", { importance: 1 });
    const high = makeObservation("obs_high", { importance: 9 });
    const { run, store } = runEvict({
      observations: [low, high],
      maxObservationsPerProject: 1,
      facets: [
        ...facetsFor("obs_low", "observation", ["service", "stage"]),
        ...facetsFor("obs_high", "observation", ["service"]),
      ],
    });

    const stats = await run();

    expect(stats.capEvictions).toBe(1);
    expect(stats.facetsRemoved).toBe(2);
    expect(facetIds(store)).toEqual(["fct_obs_high_service"]);
  });

  // Keyless installs compress without an LLM (compress-synthetic.ts:88-101):
  // empty facts/concepts, fixed importance 5, title = tool name. Every other
  // fixture here is LLM-shaped, so this pins the cap branch for the shape the
  // production daemon actually stores.
  it("removes the facets of a cap-evicted synthetic-form observation", async () => {
    const synthetic: CompressedObservation = {
      id: "obs_synth",
      sessionId: SESSION_ID,
      timestamp: daysAgo(1),
      type: "file_read",
      title: "Read",
      subtitle: '{"file_path":"src/state/kv.ts"}',
      facts: [],
      narrative: '{"file_path":"src/state/kv.ts"} | file contents',
      concepts: [],
      files: ["src/state/kv.ts"],
      importance: 5,
      confidence: 0.3,
    };
    const high = makeObservation("obs_high", { importance: 9 });
    const { run, store } = runEvict({
      observations: [synthetic, high],
      maxObservationsPerProject: 1,
      facets: [
        ...facetsFor("obs_synth", "observation", ["service", "stage"]),
        ...facetsFor("obs_high", "observation", ["service"]),
      ],
    });

    const stats = await run();

    expect(stats.capEvictions).toBe(1);
    expect(stats.lowImportanceObs).toBe(0);
    expect(stats.facetsRemoved).toBe(2);
    expect(facetIds(store)).toEqual(["fct_obs_high_service"]);
  });

  it("removes the facets of a low-importance evicted observation", async () => {
    const low = makeObservation("obs_low", {
      importance: 1,
      timestamp: daysAgo(200),
    });
    const { run, store } = runEvict({
      observations: [low],
      facets: facetsFor("obs_low", "observation", ["service", "wave"]),
    });

    const stats = await run();

    expect(stats.lowImportanceObs).toBe(1);
    expect(stats.facetsRemoved).toBe(2);
    expect(facetIds(store)).toEqual([]);
  });

  it("does not cascade on the stale-session branch", async () => {
    const stale: Session = {
      id: "ses_stale",
      project: "agentmemory",
      cwd: "/repo/agentmemory",
      startedAt: daysAgo(31),
      status: "active",
      observationCount: 0,
    };
    // A facet row pointing at the session id cannot be produced through
    // mem::facet-tag (facets.ts:18 rejects that targetType), so it is planted
    // here by hand: if anyone ever wires the cascade into the session branch,
    // this row disappears and the test fails.
    const sessionFacet: Facet = {
      id: "fct_ses_stale_service",
      targetId: "ses_stale",
      targetType: "memory",
      dimension: "service",
      value: "agentmemory",
      createdAt: daysAgo(1),
    };
    const store = new Map<string, Map<string, unknown>>([
      [KV.sessions, new Map<string, unknown>([[stale.id, stale]])],
      [KV.summaries, new Map()],
      [KV.observations(stale.id), new Map()],
      [KV.memories, new Map()],
      [KV.facets, new Map<string, unknown>([[sessionFacet.id, sessionFacet]])],
      [KV.config, new Map()],
      [KV.audit, new Map()],
      [KV.accessLog, new Map()],
    ]);
    const { run } = runEvictOn(store);

    const stats = await run();

    expect(stats.staleSessions).toBe(1);
    expect(stats.facetsRemoved).toBe(0);
    expect(facetIds(store)).toEqual(["fct_ses_stale_service"]);
  });

  it("scans the facet namespace exactly once per run", async () => {
    const expired = makeMemory({
      id: "mem_expired",
      forgetAfter: "2020-01-01T00:00:00Z",
    });
    const nonLatest = makeMemory({
      id: "mem_non_latest",
      isLatest: false,
      createdAt: daysAgo(200),
      updatedAt: daysAgo(200),
    });
    const low = makeObservation("obs_low", { importance: 1 });
    const old = makeObservation("obs_old", {
      importance: 1,
      timestamp: daysAgo(200),
    });
    const { run, listCalls } = runEvict({
      memories: [expired, nonLatest],
      observations: [low, old],
      maxObservationsPerProject: 1,
      facets: [
        ...facetsFor("mem_expired", "memory"),
        ...facetsFor("mem_non_latest", "memory"),
        ...facetsFor("obs_low", "observation", ["service"]),
        ...facetsFor("obs_old", "observation", ["service"]),
      ],
    });

    const stats = await run();

    expect(
      stats.lowImportanceObs +
        stats.capEvictions +
        stats.expiredMemories +
        stats.nonLatestMemories,
    ).toBeGreaterThan(1);
    // Four evicted targets, one scan: catches a kv.list moved into a branch,
    // which is the quadratic shape this design exists to avoid.
    expect(listCalls.get(KV.facets)).toBe(1);
  });

  it("keeps sweeping when a facet delete fails", async () => {
    const expired = makeMemory({
      id: "mem_expired",
      forgetAfter: "2020-01-01T00:00:00Z",
    });
    const store = makeStore({
      memories: [expired],
      facets: facetsFor("mem_expired", "memory", ["service", "wave"]),
    });
    const listCalls = new Map<string, number>();
    const kv = mockKV(store, listCalls);
    const failing = {
      ...kv,
      delete: async (scope: string, key: string): Promise<void> => {
        if (scope === KV.facets && key === "fct_mem_expired_service") {
          throw new Error("state::delete refused");
        }
        return kv.delete(scope, key);
      },
    };
    const { sdk } = mockSdk();
    registerEvictFunction(sdk as never, failing as never);
    setIndexPersistence({ scheduleSave: vi.fn(), save: vi.fn(async () => {}) });

    const stats = (await sdk.trigger({
      function_id: "mem::evict",
      payload: {},
    })) as EvictStats;

    // The target is already gone; a refused facet delete must not abort the
    // run or undo the eviction it followed.
    expect(stats.expiredMemories).toBe(1);
    expect(stats.facetsRemoved).toBe(1);
    expect(store.get(KV.memories)!.has("mem_expired")).toBe(false);
    expect(facetIds(store)).toEqual(["fct_mem_expired_service"]);
    expect(
      (auditRows(store).find((a) => a.details?.resource === "facet")
        ?.targetIds ?? []).sort(),
    ).toEqual(["fct_mem_expired_wave"]);
  });

  it("writes one batched facet audit row per run", async () => {
    const expired = makeMemory({
      id: "mem_expired",
      forgetAfter: "2020-01-01T00:00:00Z",
    });
    const low = makeObservation("obs_low", {
      importance: 1,
      timestamp: daysAgo(200),
    });
    const { run, store } = runEvict({
      memories: [expired],
      observations: [low],
      facets: [
        ...facetsFor("mem_expired", "memory", ["service", "wave"]),
        ...facetsFor("obs_low", "observation", ["service"]),
      ],
    });

    const stats = await run();

    expect(stats.facetsRemoved).toBe(3);
    const facetRows = auditRows(store).filter(
      (a) => a.details?.resource === "facet",
    );
    expect(facetRows).toHaveLength(1);
    expect(facetRows[0].operation).toBe("delete");
    expect(facetRows[0].functionId).toBe("mem::evict");
    expect(facetRows[0].details?.reason).toBe("cascade_target_evicted");
    // Ids of both target types land in the one row (Р-В7-10).
    expect([...facetRows[0].targetIds].sort()).toEqual([
      "fct_mem_expired_service",
      "fct_mem_expired_wave",
      "fct_obs_low_service",
    ]);
    // The per-object rows of the wave-2 decision are untouched.
    expect(
      auditRows(store).filter((a) => a.details?.resource === "memory"),
    ).toHaveLength(1);
    expect(
      auditRows(store).filter((a) => a.details?.resource === "observation"),
    ).toHaveLength(1);
  });
});
