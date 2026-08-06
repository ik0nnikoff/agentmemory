import { SearchIndex } from "./search-index.js";
import { VectorIndex } from "./vector-index.js";
import type { StateKV } from "./kv.js";
import { KV, generateId } from "./schema.js";
import { logger } from "../logger.js";
import { safeAudit } from "../functions/audit.js";
import { withKeyedLock } from "./keyed-mutex.js";

const DEBOUNCE_MS = 5000;
const FAILURE_LOG_THROTTLE_MS = 60_000;
const INDEX_PERSISTENCE_FUNCTION_ID = "mem::index-persistence";
const SAVE_LOCK_KEY = "mem::index-persistence:save";
const BM25_KEY = "data";
const BM25_MANIFEST_KEY = "data:manifest";
const BM25_SHARD_SCOPE_PREFIX = `${KV.bm25Index}:bm25:`;
const VECTOR_KEY = "vectors";
const VECTOR_MANIFEST_KEY = "vectors:manifest";
const VECTOR_SHARD_SCOPE_PREFIX = `${KV.bm25Index}:vectors:`;
const INDEX_SHARD_KEY = "data";
const DEFAULT_INDEX_SHARD_CHARS = 2_000_000;

type IndexShardManifest = {
  v: 1;
  generation?: string;
  shards: Array<{ scope: string; key: string; chars: number }>;
  chars: number;
};

type IndexPersistenceOptions = {
  shardChars?: number;
  createGeneration?: () => string;
};

/**
 * Boot-time sweep of shard generations no manifest references (D-10).
 * "dry" only counts and logs; "on" deletes; "off" does nothing.
 */
export type IndexOrphanSweepMode = "off" | "dry" | "on";

export type IndexOrphanSweepResult = {
  mode: IndexOrphanSweepMode;
  /** false when a fail-closed gate stopped the sweep before any delete */
  swept: boolean;
  skippedReason?: string;
  /** orphan shard scopes that still hold data */
  candidates: string[];
  deleted: number;
};

/** Live picture assembled from BOTH manifests; deletion needs all of it. */
type LiveShardPicture = {
  scopes: Set<string>;
  generations: Set<string>;
};

const ORPHAN_SWEEP_REASON = "orphan_generation_sweep";

/**
 * Anything but the three known words — including an unset variable — is
 * "dry". The boot path must never fall into deleting because a typo in
 * the env looked like a mode (invariant: production mode is explicit).
 */
export function resolveIndexOrphanSweepMode(
  raw: string | undefined,
): IndexOrphanSweepMode {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "off" || value === "dry" || value === "on") return value;
  return "dry";
}

function shardChars(options: IndexPersistenceOptions): number {
  const configured = options.shardChars;
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return DEFAULT_INDEX_SHARD_CHARS;
  }
  const wholeChars = Math.floor(configured);
  return wholeChars >= 1 ? wholeChars : DEFAULT_INDEX_SHARD_CHARS;
}

function createIndexGeneration(): string {
  return generateId("idx");
}

function statePath(scope: string, key: string): string {
  return `${scope}/${key}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isValidShardDescriptor(
  shard: unknown,
): shard is IndexShardManifest["shards"][number] {
  if (!shard || typeof shard !== "object") return false;
  const candidate = shard as { scope?: unknown; key?: unknown; chars?: unknown };
  return (
    typeof candidate.scope === "string" &&
    candidate.scope.length > 0 &&
    typeof candidate.key === "string" &&
    candidate.key.length > 0 &&
    Number.isInteger(candidate.chars) &&
    candidate.chars >= 0
  );
}

/**
 * `mem:index:bm25:bm25:<generation>:00007` -> generation `<generation>`.
 * Returns null for anything that is not exactly a shard scope of one of
 * the two known prefixes: the sweep must never widen past them.
 */
function parseShardScope(
  scope: string,
): { prefix: string; generation: string } | null {
  for (const prefix of [BM25_SHARD_SCOPE_PREFIX, VECTOR_SHARD_SCOPE_PREFIX]) {
    if (!scope.startsWith(prefix)) continue;
    const rest = scope.slice(prefix.length);
    const separator = rest.indexOf(":");
    if (separator <= 0) return null;
    const generation = rest.slice(0, separator);
    const shardIndex = rest.slice(separator + 1);
    // saveShardedIndex pads the shard index to five digits (:196-199).
    if (!/^[0-9]{5}$/.test(shardIndex)) return null;
    return { prefix, generation };
  }
  return null;
}

export class IndexPersistence {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastFailureLogAt = 0;

  constructor(
    private kv: StateKV,
    private bm25: SearchIndex,
    private vector: VectorIndex | null,
    private options: IndexPersistenceOptions = {},
  ) {}

  scheduleSave(): void {
    if (this.timer) clearTimeout(this.timer);
    // setTimeout discards the returned promise, so any rejection inside
    // save() would surface as unhandledRejection and crash the process
    // under sustained iii-engine write timeouts (issue #204). Funnel
    // rejections through logFailure() instead.
    this.timer = setTimeout(() => {
      this.save().catch((err) => this.logFailure(err));
    }, DEBOUNCE_MS);
  }

  async save(): Promise<void> {
    // Debounce cancellation stays OUTSIDE the lock: a timer armed while the
    // lock is held would fire during the wait and queue a redundant save.
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Both halves under ONE key: saveShardedIndex() reads the previous
    // manifest first and deletes its shards last, so two overlapping saves
    // publish two generations and both delete the old one, orphaning one of
    // the new ones forever (D-26).
    return withKeyedLock(SAVE_LOCK_KEY, async () => {
      try {
        await this.saveBm25Index(this.bm25.serialize());
        if (this.vector) {
          await this.saveVectorIndex(this.vector.serialize());
        }
      } catch (err) {
        this.logFailure(err);
      }
    });
  }

  async load(): Promise<{
    bm25: SearchIndex | null;
    vector: VectorIndex | null;
  }> {
    let bm25: SearchIndex | null = null;
    let vector: VectorIndex | null = null;

    const bm25Data = await this.loadBm25Data();
    if (bm25Data && typeof bm25Data === "string") {
      bm25 = SearchIndex.deserialize(bm25Data);
    }

    const vecData = await this.loadVectorData();
    if (vecData && typeof vecData === "string") {
      vector = VectorIndex.deserialize(vecData);
    }

    return { bm25, vector };
  }

  /**
   * Delete shard generations that no manifest points at any more (D-10).
   *
   * saveShardedIndex() publishes the new manifest (:225) and only then
   * walks the previous generation shard by shard (:268-276). A process
   * death inside that loop leaves shards nothing references: the manifest
   * link is already gone, load() never reads them, and no runtime path
   * enumerates the namespace. They only grow the store — 55 MB in the
   * observed case. This sweep is the one path that can remove them.
   *
   * Safety, in order of importance:
   *   - fail-closed: an unreadable or malformed manifest (either of the
   *     two) aborts the whole sweep — deleting on a partial picture is
   *     how you delete the live index;
   *   - only the two shard prefixes are ever considered, and only scopes
   *     that parse as `<prefix><generation>:<5 digits>`;
   *   - a scope is deleted only when it is BOTH absent from the live
   *     scope set AND carries a generation no manifest mentions;
   *   - it runs under save()'s lock key, so no save can publish a new
   *     generation between "read the manifests" and "list the scopes";
   *   - every delete writes an audit row, plus one summary row.
   *
   * Non-fatal by construction: any failure returns a skipped result, boot
   * continues.
   */
  async sweepOrphanGenerations(
    mode: IndexOrphanSweepMode = "dry",
  ): Promise<IndexOrphanSweepResult> {
    const skipped = (reason: string): IndexOrphanSweepResult => ({
      mode,
      swept: false,
      skippedReason: reason,
      candidates: [],
      deleted: 0,
    });
    if (mode === "off") return skipped("disabled");

    return withKeyedLock(SAVE_LOCK_KEY, async () => {
      try {
        const live = await this.readLiveShardPicture();
        if (!live) return skipped("manifest_unusable");

        let groups: string[];
        try {
          groups = await this.kv.listGroups();
        } catch (err) {
          logger.warn(
            "index persistence: orphan sweep skipped, scope listing failed",
            { message: errorMessage(err) },
          );
          return skipped("list_groups_failed");
        }

        // Cheap filter first (string work), then one read per surviving
        // candidate: iii-engine keeps an emptied scope in list_groups
        // until the next engine restart, so without the emptiness check a
        // second boot would re-delete and re-audit the same dead scopes.
        const orphanScopes = groups
          .filter((scope) => this.isOrphanShardScope(scope, live))
          .sort();
        const candidates: string[] = [];
        for (const scope of orphanScopes) {
          if (await this.shardScopeHasData(scope)) candidates.push(scope);
        }
        if (candidates.length === 0) {
          return { mode, swept: true, candidates: [], deleted: 0 };
        }

        const generations = Array.from(
          new Set(
            candidates
              .map((scope) => parseShardScope(scope)?.generation)
              .filter((generation): generation is string => !!generation),
          ),
        ).sort();
        // Intent is recorded BEFORE the first delete (audit.ts:16-31), so
        // a sweep that dies halfway still leaves the candidate list.
        await this.auditIndexPersistence(
          "orphan_sweep",
          candidates.map((scope) => statePath(scope, INDEX_SHARD_KEY)),
          {
            reason: ORPHAN_SWEEP_REASON,
            mode,
            candidates: candidates.length,
            generations,
            result: mode === "dry" ? "dry_run" : "sweeping",
          },
        );
        logger.info("index persistence: orphan shard generations found", {
          mode,
          candidates: candidates.length,
          generations,
          scopes: candidates.slice(0, 10),
        });
        if (mode === "dry") {
          return { mode, swept: true, candidates, deleted: 0 };
        }

        let deleted = 0;
        for (const scope of candidates) {
          const removed = await this.deleteKey(
            scope,
            INDEX_SHARD_KEY,
            ORPHAN_SWEEP_REASON,
          );
          if (removed) deleted += 1;
        }
        return { mode, swept: true, candidates, deleted };
      } catch (err) {
        logger.warn("index persistence: orphan sweep failed", {
          message: errorMessage(err),
        });
        return skipped("error");
      }
    });
  }

  /**
   * Live scopes and generations from BOTH manifests. Returns null — and
   * the caller deletes nothing — as soon as anything is off: unreadable
   * manifest, wrong shape, or a shard scope this code cannot recognise.
   */
  private async readLiveShardPicture(): Promise<LiveShardPicture | null> {
    const picture: LiveShardPicture = {
      scopes: new Set<string>(),
      generations: new Set<string>(),
    };
    for (const manifestKey of [BM25_MANIFEST_KEY, VECTOR_MANIFEST_KEY]) {
      let manifest: IndexShardManifest | null;
      try {
        manifest = await this.kv.get<IndexShardManifest>(
          KV.bm25Index,
          manifestKey,
        );
      } catch (err) {
        logger.warn(
          "index persistence: orphan sweep skipped, manifest read failed",
          { manifestKey, message: errorMessage(err) },
        );
        return null;
      }
      // Same shape check as loadManifestData (:407-422). "Absent" counts
      // as unusable on purpose: with no manifest every shard scope in the
      // store would look orphaned.
      if (
        manifest == null ||
        typeof manifest !== "object" ||
        manifest.v !== 1 ||
        !Array.isArray(manifest.shards) ||
        manifest.shards.length === 0 ||
        !Number.isInteger(manifest.chars) ||
        manifest.chars < 0
      ) {
        logger.warn(
          "index persistence: orphan sweep skipped, manifest absent or invalid",
          { manifestKey },
        );
        return null;
      }
      for (const shard of manifest.shards) {
        const parsed = isValidShardDescriptor(shard)
          ? parseShardScope(shard.scope)
          : null;
        if (!parsed) {
          logger.warn(
            "index persistence: orphan sweep skipped, manifest shard unrecognised",
            { manifestKey },
          );
          return null;
        }
        picture.scopes.add(shard.scope);
        picture.generations.add(parsed.generation);
      }
      if (
        typeof manifest.generation === "string" &&
        manifest.generation.length > 0
      ) {
        picture.generations.add(manifest.generation);
      }
    }
    return picture;
  }

  private isOrphanShardScope(scope: string, live: LiveShardPicture): boolean {
    const parsed = parseShardScope(scope);
    // Not a shard scope of the two known prefixes -> not ours, ever.
    if (!parsed) return false;
    if (live.scopes.has(scope)) return false;
    return !live.generations.has(parsed.generation);
  }

  private async shardScopeHasData(scope: string): Promise<boolean> {
    try {
      const values = await this.kv.list<unknown>(scope);
      return Array.isArray(values) && values.length > 0;
    } catch (err) {
      logger.warn(
        "index persistence: orphan sweep skipped a scope, listing failed",
        { scope, message: errorMessage(err) },
      );
      return false;
    }
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private logFailure(err: unknown): void {
    const now = Date.now();
    // Throttle: persistence failures under load arrive in bursts
    // (iii-engine queue pressure). Logging every debounce flush adds
    // noise without information.
    if (now - this.lastFailureLogAt < FAILURE_LOG_THROTTLE_MS) return;
    this.lastFailureLogAt = now;
    const code = (err as { code?: string })?.code;
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("index persistence: failed to save BM25/vector index", {
      code,
      message,
      hint:
        code === "TIMEOUT"
          ? "iii-engine state::set timed out; recent index updates remain in memory and will retry on the next debounce flush"
          : undefined,
    });
  }

  private async saveBm25Index(serialized: string): Promise<void> {
    await this.saveShardedIndex(
      serialized,
      BM25_MANIFEST_KEY,
      BM25_KEY,
      BM25_SHARD_SCOPE_PREFIX,
    );
  }

  private async saveVectorIndex(serialized: string): Promise<void> {
    await this.saveShardedIndex(
      serialized,
      VECTOR_MANIFEST_KEY,
      VECTOR_KEY,
      VECTOR_SHARD_SCOPE_PREFIX,
    );
  }

  private async saveShardedIndex(
    serialized: string,
    manifestKey: string,
    legacyKey: string,
    scopePrefix: string,
  ): Promise<void> {
    const previous = await this.kv
      .get<IndexShardManifest>(KV.bm25Index, manifestKey)
      .catch(() => null);
    const generation =
      this.options.createGeneration?.() ?? createIndexGeneration();
    const chunkChars = shardChars(this.options);
    const shards: IndexShardManifest["shards"] = [];
    const chunks: string[] = [];

    for (let offset = 0; offset < serialized.length; offset += chunkChars) {
      const shardIndex = shards.length;
      const scope = `${scopePrefix}${generation}:${String(shardIndex).padStart(
        5,
        "0",
      )}`;
      const chunk = serialized.slice(offset, offset + chunkChars);
      shards.push({ scope, key: INDEX_SHARD_KEY, chars: chunk.length });
      chunks.push(chunk);
    }

    const writeResults = await Promise.allSettled(
      shards.map(async (shard, index) => {
        const chunk = chunks[index] ?? "";
        await this.kv.set(shard.scope, shard.key, chunk);
        await this.auditIndexPersistence("shard_write", [
          statePath(shard.scope, shard.key),
        ], {
          scope: shard.scope,
          key: shard.key,
          manifestKey,
          generation,
          chars: chunk.length,
        });
      }),
    );
    const failedWrite = writeResults.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failedWrite) {
      await this.deleteShards(shards, "shard_write_rollback");
      throw failedWrite.reason;
    }

    const nextManifest: IndexShardManifest = {
      v: 1,
      generation,
      shards,
      chars: serialized.length,
    };
    try {
      await this.kv.set<IndexShardManifest>(
        KV.bm25Index,
        manifestKey,
        nextManifest,
      );
      await this.auditIndexPersistence("manifest_publish", [
        statePath(KV.bm25Index, manifestKey),
      ], {
        manifestKey,
        generation,
        chars: serialized.length,
        shards: shards.length,
        result: "committed",
      });
    } catch (err) {
      if (await this.isManifestPublished(manifestKey, nextManifest)) {
        await this.auditIndexPersistence("manifest_publish", [
          statePath(KV.bm25Index, manifestKey),
        ], {
          manifestKey,
          generation,
          chars: serialized.length,
          shards: shards.length,
          result: "committed_after_error",
          error: errorMessage(err),
        });
      } else {
        await this.deleteShards(shards, "manifest_publish_rollback");
      }
      throw err;
    }

    await this.deleteKey(KV.bm25Index, legacyKey, "legacy_cleanup");
    if (previous?.v === 1 && Array.isArray(previous.shards)) {
      const currentShardIds = new Set(
        shards.map((shard) => `${shard.scope}\0${shard.key}`),
      );
      for (const shard of previous.shards) {
        if (currentShardIds.has(`${shard.scope}\0${shard.key}`)) continue;
        await this.deleteShards([shard], "previous_generation_cleanup");
      }
    }
  }

  private async auditIndexPersistence(
    action: string,
    targetIds: string[],
    details: Record<string, unknown>,
  ): Promise<void> {
    await safeAudit(
      this.kv,
      "index_persist",
      INDEX_PERSISTENCE_FUNCTION_ID,
      targetIds,
      { action, ...details },
    );
  }

  /** @returns true when kv.delete accepted the key; never throws. */
  private async deleteKey(
    scope: string,
    key: string,
    reason: string,
  ): Promise<boolean> {
    let result = "deleted";
    let error: string | undefined;
    try {
      await this.kv.delete(scope, key);
    } catch (err) {
      result = "failed";
      error = errorMessage(err);
    }
    await this.auditIndexPersistence("delete", [statePath(scope, key)], {
      scope,
      key,
      reason,
      result,
      error,
    });
    return result === "deleted";
  }

  private async deleteShards(
    shards: IndexShardManifest["shards"],
    reason: string,
  ): Promise<void> {
    for (const shard of shards) {
      await this.deleteKey(shard.scope, shard.key, reason);
    }
  }

  private async isManifestPublished(
    manifestKey: string,
    expected: IndexShardManifest,
  ): Promise<boolean> {
    const published = await this.kv
      .get<IndexShardManifest>(KV.bm25Index, manifestKey)
      .catch(() => null);
    if (
      published?.v !== 1 ||
      published.generation !== expected.generation ||
      published.chars !== expected.chars ||
      !Array.isArray(published.shards) ||
      published.shards.length !== expected.shards.length
    ) {
      return false;
    }
    return published.shards.every((shard, index) => {
      const expectedShard = expected.shards[index];
      if (!expectedShard) return false;
      return (
        shard.scope === expectedShard.scope &&
        shard.key === expectedShard.key &&
        shard.chars === expectedShard.chars
      );
    });
  }

  private async loadBm25Data(): Promise<string | null> {
    return this.loadShardedData(BM25_KEY, BM25_MANIFEST_KEY, "BM25");
  }

  private async loadVectorData(): Promise<string | null> {
    return this.loadShardedData(VECTOR_KEY, VECTOR_MANIFEST_KEY, "vector");
  }

  private async loadShardedData(
    legacyKey: string,
    manifestKey: string,
    label: string,
  ): Promise<string | null> {
    const manifest = await this.readIndexValue<IndexShardManifest>(
      KV.bm25Index,
      manifestKey,
      label,
      "manifest",
    );
    if (!manifest.ok) return null;
    // #797: some iii-state adapters return `undefined` (not `null`) for
    // a missing key. The previous `value !== null` check passed
    // undefined through to loadManifestData, which then crashed on
    // `manifest.v` with TypeError. Treat both null and undefined as
    // "no manifest" and fall through to the legacy path. The shape
    // check stays so a malformed-but-present row still fails closed.
    if (
      manifest.value != null &&
      typeof manifest.value === "object"
    ) {
      return this.loadManifestData(manifest.value, label);
    }

    const legacy = await this.readIndexValue<string>(
      KV.bm25Index,
      legacyKey,
      label,
      "legacy",
    );
    if (!legacy.ok) return null;
    if (legacy.value && typeof legacy.value === "string") return legacy.value;
    return null;
  }

  private async readIndexValue<T>(
    scope: string,
    key: string,
    label: string,
    source: "manifest" | "legacy",
  ): Promise<{ ok: true; value: T | null } | { ok: false }> {
    try {
      return { ok: true, value: await this.kv.get<T>(scope, key) };
    } catch (err) {
      logger.warn(`index persistence: ${label} ${source} read failed`, {
        scope,
        key,
        message: errorMessage(err),
      });
      return { ok: false };
    }
  }

  private async loadManifestData(
    manifest: IndexShardManifest,
    label: string,
  ): Promise<string | null> {
    if (
      manifest.v !== 1 ||
      !Array.isArray(manifest.shards) ||
      manifest.shards.length === 0 ||
      !Number.isInteger(manifest.chars) ||
      manifest.chars < 0
    ) {
      logger.warn(`index persistence: ${label} shard manifest invalid`);
      return null;
    }
    for (const shard of manifest.shards) {
      if (!isValidShardDescriptor(shard)) {
        logger.warn(`index persistence: ${label} shard manifest invalid`);
        return null;
      }
    }
    const loadedShards = await Promise.all(
      manifest.shards.map(async (shard) => ({
        shard,
        chunk: await this.kv.get<string>(shard.scope, shard.key).catch(() => null),
      })),
    );
    const chunks: string[] = [];
    let chars = 0;
    for (const { shard, chunk } of loadedShards) {
      if (typeof chunk !== "string") {
        logger.warn(`index persistence: ${label} shard missing`, {
          scope: shard.scope,
          key: shard.key,
        });
        return null;
      }
      if (chunk.length !== shard.chars) {
        logger.warn(`index persistence: ${label} shard length mismatch`, {
          scope: shard.scope,
          key: shard.key,
          expected: shard.chars,
          actual: chunk.length,
        });
        return null;
      }
      chunks.push(chunk);
      chars += chunk.length;
    }
    if (chars !== manifest.chars) {
      logger.warn(`index persistence: ${label} total length mismatch`, {
        expected: manifest.chars,
        actual: chars,
      });
      return null;
    }
    return chunks.join("");
  }
}
