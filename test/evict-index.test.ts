import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompressedObservation, Memory, Session } from "../src/types.js";
import { registerEvictFunction } from "../src/functions/evict.js";
import {
  getSearchIndex,
  getVectorIndex,
  setIndexPersistence,
  setVectorIndex,
} from "../src/functions/search.js";
import { VectorIndex } from "../src/state/vector-index.js";
import { memoryToObservation } from "../src/state/memory-utils.js";
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

const SESSION_ID = "ses_evict_index";

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function mockKV(store: Store) {
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

// A session young enough that the stale-session branch never fires: this
// suite is about the observation/memory branches only.
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

// Recent + important: skips the low-importance branch, so only the
// project-cap branch can evict it.
function makeObservation(
  id: string,
  importance: number,
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
    importance,
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

interface Fixture {
  observations?: CompressedObservation[];
  memories?: Memory[];
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
    [KV.config, config],
    [KV.audit, new Map()],
    [KV.accessLog, new Map()],
  ]);
}

function indexObservation(obs: CompressedObservation): void {
  getSearchIndex().add(obs);
  getVectorIndex()!.add(obs.id, obs.sessionId, new Float32Array([0.1, 0.2]));
}

function indexMemory(mem: Memory): void {
  const asObs = memoryToObservation(mem);
  getSearchIndex().add(asObs);
  getVectorIndex()!.add(
    asObs.id,
    asObs.sessionId,
    new Float32Array([0.3, 0.4]),
  );
}

function vectorHas(id: string): boolean {
  return (
    JSON.parse(getVectorIndex()!.serialize()) as Array<[string, unknown]>
  ).some(([obsId]) => obsId === id);
}

function runEvict(
  fixture: Fixture,
  payload: { dryRun?: boolean } = {},
): {
  run: () => Promise<unknown>;
  persistence: { scheduleSave: ReturnType<typeof vi.fn>; save: ReturnType<typeof vi.fn> };
} {
  const store = makeStore(fixture);
  const kv = mockKV(store);
  const { sdk } = mockSdk();
  registerEvictFunction(sdk as never, kv as never);
  const persistence = { scheduleSave: vi.fn(), save: vi.fn(async () => {}) };
  setIndexPersistence(persistence);
  return {
    persistence,
    run: () => sdk.trigger({ function_id: "mem::evict", payload }),
  };
}

describe("mem::evict search-index cleanup", () => {
  beforeEach(() => {
    getSearchIndex().clear();
    setVectorIndex(new VectorIndex());
    setIndexPersistence(null);
  });

  afterEach(() => {
    getSearchIndex().clear();
    setVectorIndex(null);
    setIndexPersistence(null);
  });

  it("removes cap-evicted observations from the BM25 index", async () => {
    const low = makeObservation("obs_low", 1);
    const high = makeObservation("obs_high", 9);
    const { run } = runEvict({
      observations: [low, high],
      maxObservationsPerProject: 1,
    });
    indexObservation(low);
    indexObservation(high);
    expect(getSearchIndex().has("obs_low")).toBe(true);

    const stats = (await run()) as { capEvictions: number };

    expect(stats.capEvictions).toBe(1);
    expect(getSearchIndex().has("obs_low")).toBe(false);
    // The survivor must stay: a blanket clear() would also make the line above pass.
    expect(getSearchIndex().has("obs_high")).toBe(true);
  });

  it("removes cap-evicted observations from the vector index", async () => {
    const low = makeObservation("obs_low", 1);
    const high = makeObservation("obs_high", 9);
    const { run } = runEvict({
      observations: [low, high],
      maxObservationsPerProject: 1,
    });
    indexObservation(low);
    indexObservation(high);
    expect(getVectorIndex()!.size).toBe(2);

    await run();

    // VectorIndex has no has(); check both the count and the serialized ids.
    expect(getVectorIndex()!.size).toBe(1);
    expect(vectorHas("obs_low")).toBe(false);
    expect(vectorHas("obs_high")).toBe(true);
  });

  it("removes TTL-expired memories from both indexes", async () => {
    const expired = makeMemory({
      id: "mem_expired",
      forgetAfter: "2020-01-01T00:00:00Z",
    });
    const kept = makeMemory({ id: "mem_kept" });
    const { run } = runEvict({ memories: [expired, kept] });
    indexMemory(expired);
    indexMemory(kept);

    const stats = (await run()) as { expiredMemories: number };

    expect(stats.expiredMemories).toBe(1);
    expect(getSearchIndex().has("mem_expired")).toBe(false);
    expect(vectorHas("mem_expired")).toBe(false);
    expect(getSearchIndex().has("mem_kept")).toBe(true);
    expect(vectorHas("mem_kept")).toBe(true);
  });

  it("removes old non-latest memories from both indexes", async () => {
    const stale = makeMemory({
      id: "mem_non_latest",
      isLatest: false,
      createdAt: daysAgo(200),
      updatedAt: daysAgo(200),
    });
    const kept = makeMemory({ id: "mem_kept" });
    const { run } = runEvict({ memories: [stale, kept] });
    indexMemory(stale);
    indexMemory(kept);

    const stats = (await run()) as { nonLatestMemories: number };

    expect(stats.nonLatestMemories).toBe(1);
    expect(getSearchIndex().has("mem_non_latest")).toBe(false);
    expect(vectorHas("mem_non_latest")).toBe(false);
    expect(getSearchIndex().has("mem_kept")).toBe(true);
    expect(vectorHas("mem_kept")).toBe(true);
  });

  it("flushes persistence exactly once for a run with several deletions", async () => {
    const low = makeObservation("obs_low", 1);
    const high = makeObservation("obs_high", 9);
    const expired = makeMemory({
      id: "mem_expired",
      forgetAfter: "2020-01-01T00:00:00Z",
    });
    const stale = makeMemory({
      id: "mem_non_latest",
      isLatest: false,
      createdAt: daysAgo(200),
      updatedAt: daysAgo(200),
    });
    const { run, persistence } = runEvict({
      observations: [low, high],
      memories: [expired, stale],
      maxObservationsPerProject: 1,
    });
    indexObservation(low);
    indexObservation(high);
    indexMemory(expired);
    indexMemory(stale);

    const stats = (await run()) as {
      capEvictions: number;
      expiredMemories: number;
      nonLatestMemories: number;
    };

    expect(stats.capEvictions).toBe(1);
    expect(stats.expiredMemories).toBe(1);
    expect(stats.nonLatestMemories).toBe(1);
    // Three deletions, one full index save: catches a flush moved into a loop.
    expect(persistence.save).toHaveBeenCalledTimes(1);
  });

  it("leaves the indexes and persistence untouched on dryRun", async () => {
    const low = makeObservation("obs_low", 1);
    const high = makeObservation("obs_high", 9);
    const expired = makeMemory({
      id: "mem_expired",
      forgetAfter: "2020-01-01T00:00:00Z",
    });
    const { run, persistence } = runEvict(
      {
        observations: [low, high],
        memories: [expired],
        maxObservationsPerProject: 1,
      },
      { dryRun: true },
    );
    indexObservation(low);
    indexObservation(high);
    indexMemory(expired);

    const stats = (await run()) as {
      capEvictions: number;
      expiredMemories: number;
    };

    expect(stats.capEvictions).toBe(1);
    expect(stats.expiredMemories).toBe(1);
    expect(getSearchIndex().has("obs_low")).toBe(true);
    expect(vectorHas("obs_low")).toBe(true);
    expect(getSearchIndex().has("mem_expired")).toBe(true);
    expect(vectorHas("mem_expired")).toBe(true);
    expect(persistence.save).not.toHaveBeenCalled();
  });

  it("does not flush persistence when nothing was evicted", async () => {
    const high = makeObservation("obs_high", 9);
    const kept = makeMemory({ id: "mem_kept" });
    const { run, persistence } = runEvict({
      observations: [high],
      memories: [kept],
    });
    indexObservation(high);
    indexMemory(kept);

    const stats = (await run()) as {
      lowImportanceObs: number;
      capEvictions: number;
      expiredMemories: number;
      nonLatestMemories: number;
    };

    expect(stats.lowImportanceObs).toBe(0);
    expect(stats.capEvictions).toBe(0);
    expect(stats.expiredMemories).toBe(0);
    expect(stats.nonLatestMemories).toBe(0);
    expect(persistence.save).not.toHaveBeenCalled();
  });
});
