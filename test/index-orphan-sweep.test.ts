import { describe, it, expect } from "vitest";
import {
  IndexPersistence,
  resolveIndexOrphanSweepMode,
} from "../src/state/index-persistence.js";
import { SearchIndex } from "../src/state/search-index.js";

const BM25_SCOPE = "mem:index:bm25";
const AUDIT_SCOPE = "mem:audit";
const BM25_MANIFEST_KEY = "data:manifest";
const VECTOR_MANIFEST_KEY = "vectors:manifest";
const SHARD_KEY = "data";
const LIVE_BM25_GENERATION = "idx_live_bm25";
const LIVE_VECTOR_GENERATION = "idx_live_vec";

function bm25Shard(generation: string, index: number): string {
  return `mem:index:bm25:bm25:${generation}:${String(index).padStart(5, "0")}`;
}

function vectorShard(generation: string, index: number): string {
  return `mem:index:bm25:vectors:${generation}:${String(index).padStart(
    5,
    "0",
  )}`;
}

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  const deletes: Array<{ scope: string; key: string }> = [];
  return {
    store,
    deletes,
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      deletes.push({ scope, key });
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
    // Spike fact (iii-engine 0.11.2): state::list_groups returns every
    // scope that has ever held a key in this engine lifetime — a scope
    // whose last key was deleted stays listed until the engine restarts.
    // The mock keeps the emptied Map for the same reason.
    listGroups: async (): Promise<string[]> => Array.from(store.keys()),
  };
}

type MockKV = ReturnType<typeof mockKV>;

async function seedShard(
  kv: MockKV,
  scope: string,
  chars = 5,
): Promise<{ scope: string; key: string; chars: number }> {
  await kv.set(scope, SHARD_KEY, "x".repeat(chars));
  return { scope, key: SHARD_KEY, chars };
}

async function seedLiveGenerations(kv: MockKV): Promise<void> {
  const bm25Shards = [
    await seedShard(kv, bm25Shard(LIVE_BM25_GENERATION, 0)),
    await seedShard(kv, bm25Shard(LIVE_BM25_GENERATION, 1)),
  ];
  await kv.set(BM25_SCOPE, BM25_MANIFEST_KEY, {
    v: 1,
    generation: LIVE_BM25_GENERATION,
    shards: bm25Shards,
    chars: 10,
  });
  const vectorShards = [await seedShard(kv, vectorShard(LIVE_VECTOR_GENERATION, 0))];
  await kv.set(BM25_SCOPE, VECTOR_MANIFEST_KEY, {
    v: 1,
    generation: LIVE_VECTOR_GENERATION,
    shards: vectorShards,
    chars: 5,
  });
}

function makePersistence(kv: MockKV): IndexPersistence {
  return new IndexPersistence(kv as never, new SearchIndex(), null);
}

function auditRows(kv: MockKV): Array<Record<string, unknown>> {
  const entries = kv.store.get(AUDIT_SCOPE);
  return entries
    ? (Array.from(entries.values()) as Array<Record<string, unknown>>)
    : [];
}

function auditActions(kv: MockKV): string[] {
  return auditRows(kv).map(
    (row) => (row.details as { action?: string })?.action ?? "",
  );
}

function liveScopes(): string[] {
  return [
    bm25Shard(LIVE_BM25_GENERATION, 0),
    bm25Shard(LIVE_BM25_GENERATION, 1),
    vectorShard(LIVE_VECTOR_GENERATION, 0),
  ];
}

describe("index orphan generation sweep", () => {
  it("deletes exactly the shards of the generation missing from the manifests", async () => {
    const kv = mockKV();
    await seedLiveGenerations(kv);
    const orphans = [
      bm25Shard("idx_orphan", 0),
      bm25Shard("idx_orphan", 1),
      bm25Shard("idx_orphan", 2),
    ];
    for (const scope of orphans) await seedShard(kv, scope);

    const result = await makePersistence(kv).sweepOrphanGenerations("on");

    expect(result.swept).toBe(true);
    expect(result.candidates.sort()).toEqual([...orphans].sort());
    expect(result.deleted).toBe(3);
    expect(kv.deletes.map((d) => d.scope).sort()).toEqual([...orphans].sort());
    for (const scope of orphans) {
      expect(await kv.get(scope, SHARD_KEY)).toBeNull();
    }
  });

  it("sweeps orphaned vector-shard generations too", async () => {
    const kv = mockKV();
    await seedLiveGenerations(kv);
    const orphan = vectorShard("idx_orphan_vec", 0);
    await seedShard(kv, orphan);

    const result = await makePersistence(kv).sweepOrphanGenerations("on");

    expect(result.candidates).toEqual([orphan]);
    expect(result.deleted).toBe(1);
    expect(await kv.get(orphan, SHARD_KEY)).toBeNull();
  });

  it("leaves the live generations untouched (positive control)", async () => {
    const kv = mockKV();
    await seedLiveGenerations(kv);
    for (const scope of [bm25Shard("idx_orphan", 0), vectorShard("idx_orphan", 0)]) {
      await seedShard(kv, scope);
    }

    await makePersistence(kv).sweepOrphanGenerations("on");

    for (const scope of liveScopes()) {
      expect(await kv.get(scope, SHARD_KEY)).toBe("xxxxx");
    }
    const deletedScopes = kv.deletes.map((d) => d.scope);
    for (const scope of liveScopes()) {
      expect(deletedScopes).not.toContain(scope);
    }
  });

  // Deliberately asserts only on the store, not on the returned shape:
  // it must pass on code WITHOUT the sweep too, otherwise it would not
  // distinguish "sweeps nothing" from "sweeps on a hunch".
  it("does nothing at all when there are no orphans", async () => {
    const kv = mockKV();
    await seedLiveGenerations(kv);

    await makePersistence(kv).sweepOrphanGenerations("on");

    expect(kv.deletes).toEqual([]);
    expect(auditRows(kv)).toEqual([]);
    for (const scope of liveScopes()) {
      expect(await kv.get(scope, SHARD_KEY)).toBe("xxxxx");
    }
  });

  it("reports no candidates when there are no orphans", async () => {
    const kv = mockKV();
    await seedLiveGenerations(kv);

    const result = await makePersistence(kv).sweepOrphanGenerations("on");

    expect(result.swept).toBe(true);
    expect(result.candidates).toEqual([]);
    expect(result.deleted).toBe(0);
  });

  it("deletes nothing when a manifest cannot be read (fail-closed)", async () => {
    const kv = mockKV();
    await seedLiveGenerations(kv);
    await seedShard(kv, bm25Shard("idx_orphan", 0));
    const failingKv = {
      ...kv,
      get: async (scope: string, key: string) => {
        if (scope === BM25_SCOPE) throw new Error("state::get timed out");
        return (kv.store.get(scope)?.get(key) as unknown) ?? null;
      },
    };

    const result = await new IndexPersistence(
      failingKv as never,
      new SearchIndex(),
      null,
    ).sweepOrphanGenerations("on");

    expect(result.swept).toBe(false);
    expect(result.skippedReason).toBe("manifest_unusable");
    expect(kv.deletes).toEqual([]);
    expect(await kv.get(bm25Shard("idx_orphan", 0), SHARD_KEY)).toBe("xxxxx");
  });

  it("deletes nothing when a manifest is malformed or absent (fail-closed)", async () => {
    for (const manifest of [
      { v: 2, generation: "idx_live_bm25", shards: [], chars: 0 },
      { v: 1, generation: "idx_live_bm25", shards: [], chars: 10 },
      { v: 1, generation: "idx_live_bm25", shards: [{ scope: "nonsense", key: "data", chars: 1 }], chars: 1 },
      null,
    ]) {
      const kv = mockKV();
      await seedLiveGenerations(kv);
      await seedShard(kv, bm25Shard("idx_orphan", 0));
      if (manifest === null) {
        kv.store.get(BM25_SCOPE)!.delete(BM25_MANIFEST_KEY);
      } else {
        await kv.set(BM25_SCOPE, BM25_MANIFEST_KEY, manifest);
      }

      const result = await makePersistence(kv).sweepOrphanGenerations("on");

      expect(result.swept).toBe(false);
      expect(result.skippedReason).toBe("manifest_unusable");
      expect(kv.deletes).toEqual([]);
      expect(auditRows(kv)).toEqual([]);
    }
  });

  it("deletes nothing when the scope listing fails (fail-closed)", async () => {
    const kv = mockKV();
    await seedLiveGenerations(kv);
    await seedShard(kv, bm25Shard("idx_orphan", 0));
    const failingKv = {
      ...kv,
      listGroups: async () => {
        throw new Error("state::list_groups response: missing 'groups' array");
      },
    };

    const result = await new IndexPersistence(
      failingKv as never,
      new SearchIndex(),
      null,
    ).sweepOrphanGenerations("on");

    expect(result.swept).toBe(false);
    expect(result.skippedReason).toBe("list_groups_failed");
    expect(kv.deletes).toEqual([]);
  });

  it("counts but never deletes in dry mode", async () => {
    const kv = mockKV();
    await seedLiveGenerations(kv);
    const orphans = [bm25Shard("idx_orphan", 0), bm25Shard("idx_orphan", 1)];
    for (const scope of orphans) await seedShard(kv, scope);
    // Look-alikes and foreign namespaces must stay out of the candidate
    // list — this is the width of the filter, measured directly.
    for (const scope of [
      "mem:memories",
      "mem:index:bm25:bm25",
      "mem:index:bm25:bm25:idx_weird",
      "mem:index:bm25:bm25:idx_weird:007",
      "mem:index:bm25:vectorsish:idx_weird:00007",
    ]) {
      await kv.set(scope, "data", "keep");
    }

    const result = await makePersistence(kv).sweepOrphanGenerations("dry");

    expect(result.swept).toBe(true);
    expect(result.candidates.sort()).toEqual([...orphans].sort());
    expect(result.deleted).toBe(0);
    expect(kv.deletes).toEqual([]);
    for (const scope of orphans) {
      expect(await kv.get(scope, SHARD_KEY)).toBe("xxxxx");
    }
    // The candidates are still on the record: one summary row, no delete rows.
    expect(auditActions(kv)).toEqual(["orphan_sweep"]);
    const summary = auditRows(kv)[0]!.details as Record<string, unknown>;
    expect(summary.mode).toBe("dry");
    expect(summary.result).toBe("dry_run");
    expect(summary.candidates).toBe(2);
  });

  it("does nothing in off mode", async () => {
    const kv = mockKV();
    await seedLiveGenerations(kv);
    await seedShard(kv, bm25Shard("idx_orphan", 0));

    const result = await makePersistence(kv).sweepOrphanGenerations("off");

    expect(result.swept).toBe(false);
    expect(result.skippedReason).toBe("disabled");
    expect(kv.deletes).toEqual([]);
    expect(auditRows(kv)).toEqual([]);
  });

  it("never touches keys outside the two shard prefixes", async () => {
    const kv = mockKV();
    await seedLiveGenerations(kv);
    const untouchable = [
      ["mem:memories", "mem_1"],
      ["mem:facets", "fac_1"],
      ["mem:observations:ses_1", "obs_1"],
      // manifest scope itself
      [BM25_SCOPE, "data"],
      // shard-prefix look-alikes that do not parse as <generation>:<NNNNN>
      ["mem:index:bm25:bm25", "data"],
      ["mem:index:bm25:bm25:idx_weird", "data"],
      ["mem:index:bm25:bm25:idx_weird:007", "data"],
      ["mem:index:bm25:bm25:idx_weird:00007:extra", "data"],
      ["mem:index:bm25:vectorsish:idx_weird:00007", "data"],
    ] as const;
    for (const [scope, key] of untouchable) await kv.set(scope, key, "keep");
    await seedShard(kv, bm25Shard("idx_orphan", 0));

    await makePersistence(kv).sweepOrphanGenerations("on");

    // Store-only assertions on purpose: this test must pass on code
    // WITHOUT the sweep as well — it measures the boundary, not the
    // feature. The deletion itself is measured by the first test.
    for (const [scope, key] of untouchable) {
      expect(await kv.get(scope, key)).toBe("keep");
    }
    for (const deletion of kv.deletes) {
      expect(deletion.scope).toBe(bm25Shard("idx_orphan", 0));
    }
  });

  it("is idempotent: the second run changes nothing", async () => {
    const kv = mockKV();
    await seedLiveGenerations(kv);
    for (const scope of [bm25Shard("idx_orphan", 0), bm25Shard("idx_orphan", 1)]) {
      await seedShard(kv, scope);
    }
    const persistence = makePersistence(kv);

    const first = await persistence.sweepOrphanGenerations("on");
    const deletesAfterFirst = kv.deletes.length;
    const auditAfterFirst = auditRows(kv).length;

    const second = await persistence.sweepOrphanGenerations("on");

    expect(first.deleted).toBe(2);
    expect(second.swept).toBe(true);
    expect(second.candidates).toEqual([]);
    expect(second.deleted).toBe(0);
    expect(kv.deletes.length).toBe(deletesAfterFirst);
    expect(auditRows(kv).length).toBe(auditAfterFirst);
  });

  it("writes an audit row for every deletion plus one summary row", async () => {
    const kv = mockKV();
    await seedLiveGenerations(kv);
    const orphans = [bm25Shard("idx_orphan", 0), bm25Shard("idx_orphan", 1)];
    for (const scope of orphans) await seedShard(kv, scope);

    await makePersistence(kv).sweepOrphanGenerations("on");

    const actions = auditActions(kv);
    expect(actions.filter((a) => a === "orphan_sweep")).toHaveLength(1);
    expect(actions.filter((a) => a === "delete")).toHaveLength(2);
    const deleteRows = auditRows(kv).filter(
      (row) => (row.details as { action?: string }).action === "delete",
    );
    for (const row of deleteRows) {
      const details = row.details as Record<string, unknown>;
      expect(details.reason).toBe("orphan_generation_sweep");
      expect(details.result).toBe("deleted");
      expect(orphans).toContain(details.scope);
    }
  });

  it("keeps generations the manifest still mentions even without a shard scope match", async () => {
    const kv = mockKV();
    await seedLiveGenerations(kv);
    // A shard of the live generation that the manifest does not list —
    // e.g. a write that landed after the manifest was assembled. The
    // generation is live, so the sweep must leave it alone.
    const extraLiveShard = bm25Shard(LIVE_BM25_GENERATION, 2);
    await seedShard(kv, extraLiveShard);

    const result = await makePersistence(kv).sweepOrphanGenerations("on");

    expect(result.candidates).toEqual([]);
    expect(await kv.get(extraLiveShard, SHARD_KEY)).toBe("xxxxx");
  });
});

describe("resolveIndexOrphanSweepMode", () => {
  it("defaults to dry for anything that is not one of the three words", () => {
    expect(resolveIndexOrphanSweepMode(undefined)).toBe("dry");
    expect(resolveIndexOrphanSweepMode("")).toBe("dry");
    expect(resolveIndexOrphanSweepMode("true")).toBe("dry");
    expect(resolveIndexOrphanSweepMode("ON!")).toBe("dry");
    expect(resolveIndexOrphanSweepMode("enabled")).toBe("dry");
  });

  it("accepts the three modes case-insensitively", () => {
    expect(resolveIndexOrphanSweepMode("off")).toBe("off");
    expect(resolveIndexOrphanSweepMode(" Dry ")).toBe("dry");
    expect(resolveIndexOrphanSweepMode("ON")).toBe("on");
  });
});
