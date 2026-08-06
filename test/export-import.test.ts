import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerExportImportFunction } from "../src/functions/export-import.js";
import { VERSION } from "../src/version.js";
import {
  getSearchIndex,
  getVectorIndex,
  setIndexPersistence,
  setVectorIndex,
} from "../src/functions/search.js";
import { VectorIndex } from "../src/state/vector-index.js";
import { memoryToObservation } from "../src/state/memory-utils.js";
import type {
  Session,
  CompressedObservation,
  Memory,
  SessionSummary,
  ExportData,
} from "../src/types.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
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
  const functions = new Map<string, Function>();
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (idOrInput: string | { function_id: string; payload: unknown }, data?: unknown) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

const testSession: Session = {
  id: "ses_1",
  project: "my-project",
  cwd: "/tmp",
  startedAt: "2026-02-01T00:00:00Z",
  status: "completed",
  observationCount: 1,
};

const testObs: CompressedObservation = {
  id: "obs_1",
  sessionId: "ses_1",
  timestamp: "2026-02-01T10:00:00Z",
  type: "file_edit",
  title: "Edit auth",
  facts: ["Added check"],
  narrative: "Auth changes",
  concepts: ["auth"],
  files: ["src/auth.ts"],
  importance: 7,
};

const testMemory: Memory = {
  id: "mem_1",
  createdAt: "2026-02-01T00:00:00Z",
  updatedAt: "2026-02-01T00:00:00Z",
  type: "pattern",
  title: "Auth pattern",
  content: "Always validate tokens",
  concepts: ["auth"],
  files: [],
  sessionIds: ["ses_1"],
  strength: 5,
  version: 1,
  isLatest: true,
};

const testSummary: SessionSummary = {
  sessionId: "ses_1",
  project: "my-project",
  createdAt: "2026-02-01T00:00:00Z",
  title: "Auth work",
  narrative: "Worked on auth",
  keyDecisions: ["Use JWT"],
  filesModified: ["src/auth.ts"],
  concepts: ["auth"],
  observationCount: 1,
};

// Seeds the pre-existing corpus into both indexes, the state a real
// install is in when mem::import runs: rows in KV *and* in the index.
function indexExistingCorpus(): void {
  getSearchIndex().add(testObs);
  getVectorIndex()!.add(testObs.id, testObs.sessionId, new Float32Array([0.1, 0.2]));
  const memAsObs = memoryToObservation(testMemory);
  getSearchIndex().add(memAsObs);
  getVectorIndex()!.add(
    memAsObs.id,
    memAsObs.sessionId,
    new Float32Array([0.3, 0.4]),
  );
}

// VectorIndex exposes no has(); read the serialized ids.
function vectorHas(id: string): boolean {
  return (
    JSON.parse(getVectorIndex()!.serialize()) as Array<[string, unknown]>
  ).some(([obsId]) => obsId === id);
}

describe("Export/Import Functions", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;
  let persistence: {
    scheduleSave: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    sdk = mockSdk();
    kv = mockKV();
    // getSearchIndex() returns a module-level singleton shared across
    // tests. Clear it so index assertions here don't see rows added by
    // a prior test's import.
    getSearchIndex().clear();
    setVectorIndex(new VectorIndex());
    persistence = { scheduleSave: vi.fn(), save: vi.fn(async () => {}) };
    setIndexPersistence(persistence);
    registerExportImportFunction(sdk as never, kv as never);

    await kv.set("mem:sessions", "ses_1", testSession);
    await kv.set("mem:obs:ses_1", "obs_1", testObs);
    await kv.set("mem:memories", "mem_1", testMemory);
    await kv.set("mem:summaries", "ses_1", testSummary);
  });

  afterEach(() => {
    getSearchIndex().clear();
    setVectorIndex(null);
    setIndexPersistence(null);
  });

  it("export produces valid ExportData structure", async () => {
    const result = (await sdk.trigger("mem::export", {})) as ExportData;

    expect(result.version).toBe(VERSION);
    expect(result.exportedAt).toBeDefined();
    expect(result.sessions.length).toBe(1);
    expect(result.sessions[0].id).toBe("ses_1");
    expect(result.observations["ses_1"].length).toBe(1);
    expect(result.memories.length).toBe(1);
    expect(result.summaries.length).toBe(1);
  });

  it("import with merge strategy adds data", async () => {
    const exportData: ExportData = {
      version: "0.3.0",
      exportedAt: new Date().toISOString(),
      sessions: [{ ...testSession, id: "ses_2", observationCount: 0 }],
      observations: {},
      memories: [{ ...testMemory, id: "mem_2", title: "New pattern" }],
      summaries: [],
    };

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "merge",
    })) as { success: boolean; sessions: number; memories: number };

    expect(result.success).toBe(true);
    expect(result.sessions).toBe(1);
    expect(result.memories).toBe(1);

    const allSessions = await kv.list("mem:sessions");
    expect(allSessions.length).toBe(2);
  });

  it("import adds imported records to the search index", async () => {
    // Regression: mem::import wrote rows to KV but never indexed them.
    // On an existing install the boot rebuild gate (bm25.size === 0) is
    // false, so imported data stayed invisible to mem::search forever.
    const importedObs: CompressedObservation = {
      id: "obs_imported",
      sessionId: "ses_imported",
      timestamp: "2026-03-01T10:00:00Z",
      type: "file_edit",
      title: "Kubernetes deployment rollout",
      facts: ["Scaled replicas"],
      narrative: "Adjusted the kubernetes deployment rollout strategy",
      concepts: ["k8s"],
      files: ["deploy.yaml"],
      importance: 6,
    };
    const importedMem: Memory = {
      ...testMemory,
      id: "mem_imported",
      title: "Postgres connection pooling",
      content: "Use pgbouncer for postgres connection pooling",
    };
    const exportData: ExportData = {
      version: "0.9.28",
      exportedAt: new Date().toISOString(),
      sessions: [
        { ...testSession, id: "ses_imported", observationCount: 1 },
      ],
      observations: { ses_imported: [importedObs] },
      memories: [importedMem],
      summaries: [],
    };

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "merge",
    })) as { success: boolean; observations: number; memories: number };

    expect(result.success).toBe(true);
    expect(result.observations).toBe(1);
    expect(result.memories).toBe(1);

    const idx = getSearchIndex();
    expect(idx.has("obs_imported")).toBe(true);
    expect(idx.has("mem_imported")).toBe(true);

    const obsHit = idx.search("kubernetes rollout");
    expect(obsHit.some((r) => r.obsId === "obs_imported")).toBe(true);

    const memHit = idx.search("postgres pooling");
    expect(memHit.some((r) => r.obsId === "mem_imported")).toBe(true);
  });

  it("import with skip strategy does not overwrite existing", async () => {
    const exportData: ExportData = {
      version: "0.3.0",
      exportedAt: new Date().toISOString(),
      sessions: [testSession],
      observations: { ses_1: [testObs] },
      memories: [testMemory],
      summaries: [testSummary],
    };

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "skip",
    })) as { success: boolean; skipped: number; sessions: number };

    expect(result.success).toBe(true);
    expect(result.skipped).toBeGreaterThan(0);
    expect(result.sessions).toBe(0);
  });

  it("import with replace strategy clears existing data first", async () => {
    const newSession: Session = {
      id: "ses_new",
      project: "new-project",
      cwd: "/tmp/new",
      startedAt: "2026-03-01T00:00:00Z",
      status: "active",
      observationCount: 0,
    };
    const exportData: ExportData = {
      version: "0.3.0",
      exportedAt: new Date().toISOString(),
      sessions: [newSession],
      observations: {},
      memories: [],
      summaries: [],
    };

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "replace",
    })) as { success: boolean; sessions: number };

    expect(result.success).toBe(true);
    expect(result.sessions).toBe(1);

    const oldSession = await kv.get("mem:sessions", "ses_1");
    expect(oldSession).toBeNull();
  });

  // Regression (wave 7, Д-3(б)): "replace" wiped observations and memories
  // from KV but left their rows in BM25 and the vector index, so the index
  // kept growing with entries whose corpus was gone.
  describe("replace strategy prunes the search index", () => {
    const importedObs: CompressedObservation = {
      id: "obs_replaced",
      sessionId: "ses_replaced",
      timestamp: "2026-04-01T10:00:00Z",
      type: "file_edit",
      title: "Terraform module split",
      facts: ["Split the network module"],
      narrative: "Reworked the terraform module layout",
      concepts: ["terraform"],
      files: ["main.tf"],
      importance: 6,
    };
    const importedMem: Memory = {
      ...testMemory,
      id: "mem_replaced",
      title: "Redis eviction policy",
      content: "Use allkeys-lru for the cache instance",
    };
    const replaceData: ExportData = {
      version: "0.9.28",
      exportedAt: "2026-04-01T00:00:00Z",
      sessions: [
        {
          ...testSession,
          id: "ses_replaced",
          project: "new-project",
          observationCount: 1,
        },
      ],
      observations: { ses_replaced: [importedObs] },
      memories: [importedMem],
      summaries: [],
    };

    it("removes the old observation and memory from BM25", async () => {
      indexExistingCorpus();
      expect(getSearchIndex().has("obs_1")).toBe(true);
      expect(getSearchIndex().has("mem_1")).toBe(true);

      const result = (await sdk.trigger("mem::import", {
        exportData: replaceData,
        strategy: "replace",
      })) as { success: boolean };

      expect(result.success).toBe(true);
      expect(getSearchIndex().has("obs_1")).toBe(false);
      expect(getSearchIndex().has("mem_1")).toBe(false);
    });

    it("removes the old observation and memory from the vector index", async () => {
      indexExistingCorpus();
      expect(getVectorIndex()!.size).toBe(2);

      await sdk.trigger("mem::import", {
        exportData: replaceData,
        strategy: "replace",
      });

      // No embedding provider is wired, so the import adds nothing to the
      // vector side: both seeded rows gone means size 0.
      expect(getVectorIndex()!.size).toBe(0);
      expect(vectorHas("obs_1")).toBe(false);
      expect(vectorHas("mem_1")).toBe(false);
    });

    it("keeps the imported records in the index", async () => {
      indexExistingCorpus();

      await sdk.trigger("mem::import", {
        exportData: replaceData,
        strategy: "replace",
      });

      // Catches "pruned too much" — e.g. a clear() placed after indexRecords.
      expect(getSearchIndex().has("obs_replaced")).toBe(true);
      expect(getSearchIndex().has("mem_replaced")).toBe(true);
    });

    it("flushes persistence exactly once for the whole import", async () => {
      indexExistingCorpus();

      await sdk.trigger("mem::import", {
        exportData: replaceData,
        strategy: "replace",
      });

      // Two removals plus two additions, one full index save: catches a
      // flush moved into the replace block or into a loop.
      expect(persistence.save).toHaveBeenCalledTimes(1);
    });
  });

  it("merge strategy leaves the existing index rows in place", async () => {
    indexExistingCorpus();

    const result = (await sdk.trigger("mem::import", {
      exportData: {
        version: "0.9.28",
        exportedAt: "2026-04-01T00:00:00Z",
        sessions: [{ ...testSession, id: "ses_2", observationCount: 0 }],
        observations: {},
        memories: [{ ...testMemory, id: "mem_2", title: "New pattern" }],
        summaries: [],
      } as ExportData,
      strategy: "merge",
    })) as { success: boolean };

    expect(result.success).toBe(true);
    expect(getSearchIndex().has("obs_1")).toBe(true);
    expect(getSearchIndex().has("mem_1")).toBe(true);
    expect(vectorHas("obs_1")).toBe(true);
    expect(vectorHas("mem_1")).toBe(true);
    // One import indexed one memory, so exactly one flush — not zero.
    expect(persistence.save).toHaveBeenCalledTimes(1);
  });

  it("skip strategy leaves the index and persistence untouched", async () => {
    indexExistingCorpus();

    const result = (await sdk.trigger("mem::import", {
      exportData: {
        version: "0.9.28",
        exportedAt: "2026-04-01T00:00:00Z",
        sessions: [testSession],
        observations: { ses_1: [testObs] },
        memories: [testMemory],
        summaries: [testSummary],
      } as ExportData,
      strategy: "skip",
    })) as { success: boolean; skipped: number };

    expect(result.success).toBe(true);
    expect(result.skipped).toBeGreaterThan(0);
    expect(getSearchIndex().has("obs_1")).toBe(true);
    expect(getSearchIndex().has("mem_1")).toBe(true);
    // Nothing written, nothing indexed → no ~297 MB save.
    expect(persistence.save).not.toHaveBeenCalled();
  });

  it("export then import round-trip preserves data", async () => {
    const exported = (await sdk.trigger("mem::export", {})) as ExportData;

    const freshKv = mockKV();
    const freshSdk = mockSdk();
    registerExportImportFunction(freshSdk as never, freshKv as never);

    const importResult = (await freshSdk.trigger("mem::import", {
      exportData: exported,
      strategy: "merge",
    })) as {
      success: boolean;
      sessions: number;
      observations: number;
      memories: number;
    };

    expect(importResult.success).toBe(true);
    expect(importResult.sessions).toBe(1);
    expect(importResult.observations).toBe(1);
    expect(importResult.memories).toBe(1);

    const reExported = (await freshSdk.trigger(
      "mem::export",
      {},
    )) as ExportData;
    expect(reExported.sessions.length).toBe(exported.sessions.length);
    expect(reExported.memories.length).toBe(exported.memories.length);
  });

  it("import rejects unsupported version", async () => {
    const exportData = {
      version: "1.0.0",
      exportedAt: new Date().toISOString(),
      sessions: [],
      observations: {},
      memories: [],
      summaries: [],
    } as unknown as ExportData;

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "merge",
    })) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("Unsupported export version");
  });
});
