import type { ISdk } from "iii-sdk";
import type {
  Session,
  CompressedObservation,
  RawObservation,
  SessionSummary,
  Memory,
  Facet,
} from "../types.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { isConsolidationEnabled } from "../config.js";
import { recordAudit } from "./audit.js";
import { deleteAccessLog } from "./access-tracker.js";
import { getSearchIndex, vectorIndexRemove, flushIndexSave } from "./search.js";
import { logger } from "../logger.js";

interface EvictionConfig {
  staleSessionDays: number;
  lowImportanceMaxDays: number;
  lowImportanceThreshold: number;
  maxObservationsPerProject: number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const DEFAULTS: EvictionConfig = {
  staleSessionDays: 30,
  lowImportanceMaxDays: 90,
  lowImportanceThreshold: 3,
  maxObservationsPerProject: 10_000,
};

interface EvictionStats {
  staleSessions: number;
  lowImportanceObs: number;
  capEvictions: number;
  expiredMemories: number;
  nonLatestMemories: number;
  facetsRemoved: number;
  dryRun: boolean;
}

function isValidRecoveryResult(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  if (!("success" in result)) return true;
  return (result as { success?: unknown }).success !== false;
}

function isCompressedObservation(
  observation: CompressedObservation | RawObservation,
): observation is CompressedObservation {
  return (
    "title" in observation &&
    typeof observation.title === "string" &&
    observation.title.length > 0
  );
}

async function recoverStaleSession(
  sdk: ISdk,
  sessionId: string,
): Promise<boolean> {
  try {
    const result = await sdk.trigger({
      function_id: "event::session::stopped",
      // Suppress the per-session consolidation fan-out: eviction runs a
      // single corpus-wide consolidation pass after all recoveries instead.
      payload: { sessionId, skipConsolidation: true },
    });
    if (!isValidRecoveryResult(result)) {
      logger.warn("Stale session recovery failed", {
        sessionId,
        result,
      });
      return false;
    }
    return true;
  } catch (err) {
    logger.warn("Stale session recovery failed", {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

async function runRecoveredSessionConsolidation(sdk: ISdk): Promise<void> {
  // Same gate as the session-stop path: keyless installs must not fire
  // no-op LLM consolidation from an eviction sweep either.
  if (!isConsolidationEnabled()) return;
  try {
    await sdk.trigger({
      function_id: "mem::consolidate-pipeline",
      payload: { tier: "all", force: true },
    });
    // One crystallization pass for the batch (the per-session fan-out was
    // suppressed with skipConsolidation), keeping recovered sessions
    // consistent with normally-stopped ones without the N-fold amplification.
    await sdk.trigger({
      function_id: "mem::auto-crystallize",
      payload: { olderThanDays: 0 },
    });
  } catch (err) {
    logger.warn("Recovered session consolidation failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function registerEvictFunction(sdk: ISdk, kv: StateKV): void {
  sdk.registerFunction("mem::evict", 
    async (data: { dryRun?: boolean }): Promise<EvictionStats> => {
      const dryRun = data?.dryRun ?? false;
      const { decrementImageRef } = await import("./image-refs.js");

      const configOverride = await kv
        .get<Partial<EvictionConfig>>(KV.config, "eviction")
        .catch(() => null);
      const cfg = { ...DEFAULTS, ...configOverride };

      const now = Date.now();
      const stats: EvictionStats = {
        staleSessions: 0,
        lowImportanceObs: 0,
        capEvictions: 0,
        expiredMemories: 0,
        nonLatestMemories: 0,
        facetsRemoved: 0,
        dryRun,
      };

      let recoveredStaleSessions = 0;
      const sessions = await kv.list<Session>(KV.sessions).catch(() => []);
      const summaries = await kv
        .list<SessionSummary>(KV.summaries)
        .catch(() => []);
      const summaryIds = new Set(summaries.map((s) => s.sessionId));

      // Facet cascade (issue Д-20): the facet namespace is flat and has no
      // index by targetId (schema.ts:57), so every lookup by target is a full
      // scan. One scan per run, folded into a map, keeps the cascade linear
      // instead of N x full-scan. Deliberately unfiltered by targetType:
      // action, memory and observation are all valid facet targets
      // (types.ts:770), and the cascade must not depend on which of them carry facets
      // today. Sessions are not a valid target type, so the stale-session
      // branch below never cascades.
      const facets = await kv.list<Facet>(KV.facets).catch(() => []);
      const facetsByTarget = new Map<string, string[]>();
      for (const f of facets) {
        const list = facetsByTarget.get(f.targetId);
        if (list) list.push(f.id);
        else facetsByTarget.set(f.targetId, [f.id]);
      }
      const removedFacetIds: string[] = [];

      for (const session of sessions) {
        if (!session.startedAt) continue;
        const age = now - new Date(session.startedAt).getTime();
        const staleDays = cfg.staleSessionDays * MS_PER_DAY;
        if (age > staleDays && !summaryIds.has(session.id)) {
          if (dryRun) {
            stats.staleSessions++;
          } else {
            const observations = await kv
              .list<CompressedObservation | RawObservation>(
                KV.observations(session.id),
              )
              .catch((err) => {
                logger.warn("Stale session observation scan failed", {
                  sessionId: session.id,
                  error: err instanceof Error ? err.message : String(err),
                });
                return null;
              });
            if (!observations) continue;

            let recovered = false;
            const hasCompressedObservations = observations.some(
              isCompressedObservation,
            );
            if (hasCompressedObservations) {
              recovered = await recoverStaleSession(sdk, session.id);
              if (!recovered) continue;
              recoveredStaleSessions++;
            } else if (observations.length > 0) {
              logger.warn("Stale session has no compressed observations", {
                sessionId: session.id,
              });
              continue;
            }

            try {
              await kv.delete(KV.sessions, session.id);
              stats.staleSessions++;
            } catch (err) {
              logger.warn("Eviction delete failed", {
                resource: "session",
                id: session.id,
                error: err instanceof Error ? err.message : String(err),
              });
              continue;
            }
            await recordAudit(kv, "delete", "mem::evict", [session.id], {
              resource: "session",
              reason: recovered
                ? "stale_session_recovered_then_evicted"
                : "stale_session_without_summary",
              dryRun,
            });
          }
        }
      }

      if (!dryRun && recoveredStaleSessions > 0) {
        await runRecoveredSessionConsolidation(sdk);
      }

      const projectObs = new Map<string, CompressedObservation[]>();
      for (const session of sessions) {
        const obs = await kv
          .list<CompressedObservation>(KV.observations(session.id))
          .catch(() => []);
        const compressed = obs.filter((o) => o.title);

        for (const o of compressed) {
          if (!o.timestamp) continue;
          const age = now - new Date(o.timestamp).getTime();
          const maxAge = cfg.lowImportanceMaxDays * MS_PER_DAY;
          if (
            age > maxAge &&
            (o.importance ?? 5) < cfg.lowImportanceThreshold
          ) {
            if (dryRun) {
              stats.lowImportanceObs++;
              stats.facetsRemoved += (facetsByTarget.get(o.id) ?? []).length;
            } else {
              try {
                await kv.delete(KV.observations(session.id), o.id);
                stats.lowImportanceObs++;
              } catch (err) {
                logger.warn("Eviction delete failed", {
                  resource: "observation",
                  id: o.id,
                  sessionId: session.id,
                  error: err instanceof Error ? err.message : String(err),
                });
                continue;
              }
              if (o.imageData) await decrementImageRef(kv, sdk, o.imageData);
              if (o.imageRef && o.imageRef !== o.imageData) await decrementImageRef(kv, sdk, o.imageRef);
              await recordAudit(kv, "delete", "mem::evict", [o.id], {
                resource: "observation",
                reason: "low_importance_old_observation",
                sessionId: session.id,
                dryRun,
              });
              getSearchIndex().remove(o.id);
              vectorIndexRemove(o.id);
              for (const fid of facetsByTarget.get(o.id) ?? []) {
                try {
                  await kv.delete(KV.facets, fid);
                  removedFacetIds.push(fid);
                  stats.facetsRemoved++;
                } catch (err) {
                  logger.warn("Facet cascade delete failed", {
                    facetId: fid,
                    targetId: o.id,
                    error: err instanceof Error ? err.message : String(err),
                  });
                }
              }
            }
          }
        }

        const project = session.project || "unknown";
        const existing = projectObs.get(project) || [];
        existing.push(...compressed);
        projectObs.set(project, existing);
      }

      for (const [, obs] of projectObs) {
        if (obs.length > cfg.maxObservationsPerProject) {
          const sorted = obs.sort(
            (a, b) => (a.importance ?? 5) - (b.importance ?? 5),
          );
          const toEvict = sorted.slice(
            0,
            obs.length - cfg.maxObservationsPerProject,
          );
          if (dryRun) {
            stats.capEvictions += toEvict.length;
            for (const o of toEvict) {
              stats.facetsRemoved += (facetsByTarget.get(o.id) ?? []).length;
            }
          } else {
            for (const o of toEvict) {
              try {
                await kv.delete(KV.observations(o.sessionId), o.id);
                stats.capEvictions++;
              } catch (err) {
                logger.warn("Eviction delete failed", {
                  resource: "observation",
                  id: o.id,
                  sessionId: o.sessionId,
                  error: err instanceof Error ? err.message : String(err),
                });
                continue;
              }
              if (o.imageData) await decrementImageRef(kv, sdk, o.imageData);
              if (o.imageRef && o.imageRef !== o.imageData) await decrementImageRef(kv, sdk, o.imageRef);
              await recordAudit(kv, "delete", "mem::evict", [o.id], {
                resource: "observation",
                reason: "project_observation_cap",
                sessionId: o.sessionId,
                dryRun,
              });
              getSearchIndex().remove(o.id);
              vectorIndexRemove(o.id);
              for (const fid of facetsByTarget.get(o.id) ?? []) {
                try {
                  await kv.delete(KV.facets, fid);
                  removedFacetIds.push(fid);
                  stats.facetsRemoved++;
                } catch (err) {
                  logger.warn("Facet cascade delete failed", {
                    facetId: fid,
                    targetId: o.id,
                    error: err instanceof Error ? err.message : String(err),
                  });
                }
              }
            }
          }
        }
      }

      const memories = await kv.list<Memory>(KV.memories).catch(() => []);
      const evictedMemIds = new Set<string>();
      for (const mem of memories) {
        if (mem.forgetAfter) {
          const expiry = new Date(mem.forgetAfter).getTime();
          if (now > expiry) {
            if (dryRun) {
              stats.expiredMemories++;
              evictedMemIds.add(mem.id);
              stats.facetsRemoved += (facetsByTarget.get(mem.id) ?? []).length;
            } else {
              try {
                await kv.delete(KV.memories, mem.id);
                stats.expiredMemories++;
                evictedMemIds.add(mem.id);
              } catch (err) {
                logger.warn("Eviction delete failed", {
                  resource: "memory",
                  id: mem.id,
                  reason: "expired_memory",
                  error: err instanceof Error ? err.message : String(err),
                });
                continue;
              }
              if (mem.imageRef) {
                await decrementImageRef(kv, sdk, mem.imageRef);
              }
              await recordAudit(kv, "delete", "mem::evict", [mem.id], {
                resource: "memory",
                reason: "expired_memory",
                dryRun,
              });
              await deleteAccessLog(kv, mem.id);
              getSearchIndex().remove(mem.id);
              vectorIndexRemove(mem.id);
              for (const fid of facetsByTarget.get(mem.id) ?? []) {
                try {
                  await kv.delete(KV.facets, fid);
                  removedFacetIds.push(fid);
                  stats.facetsRemoved++;
                } catch (err) {
                  logger.warn("Facet cascade delete failed", {
                    facetId: fid,
                    targetId: mem.id,
                    error: err instanceof Error ? err.message : String(err),
                  });
                }
              }
            }
          }
        }

        if (
          !evictedMemIds.has(mem.id) &&
          mem.isLatest === false &&
          mem.createdAt
        ) {
          const age = now - new Date(mem.createdAt).getTime();
          if (age > cfg.lowImportanceMaxDays * MS_PER_DAY) {
            if (dryRun) {
              stats.nonLatestMemories++;
              stats.facetsRemoved += (facetsByTarget.get(mem.id) ?? []).length;
            } else {
              try {
                await kv.delete(KV.memories, mem.id);
                stats.nonLatestMemories++;
              } catch (err) {
                logger.warn("Eviction delete failed", {
                  resource: "memory",
                  id: mem.id,
                  reason: "old_non_latest_memory",
                  error: err instanceof Error ? err.message : String(err),
                });
                continue;
              }
              if (mem.imageRef) {
                await decrementImageRef(kv, sdk, mem.imageRef);
              }
              await recordAudit(kv, "delete", "mem::evict", [mem.id], {
                resource: "memory",
                reason: "old_non_latest_memory",
                dryRun,
              });
              await deleteAccessLog(kv, mem.id);
              getSearchIndex().remove(mem.id);
              vectorIndexRemove(mem.id);
              for (const fid of facetsByTarget.get(mem.id) ?? []) {
                try {
                  await kv.delete(KV.facets, fid);
                  removedFacetIds.push(fid);
                  stats.facetsRemoved++;
                } catch (err) {
                  logger.warn("Facet cascade delete failed", {
                    facetId: fid,
                    targetId: mem.id,
                    error: err instanceof Error ? err.message : String(err),
                  });
                }
              }
            }
          }
        }
      }

      // One flush per run, never per deletion: a full index save is ~297 MB
      // of writes. staleSessions is excluded on purpose — sessions are not
      // indexed, so evicting one leaves the index unchanged.
      if (!dryRun && (stats.lowImportanceObs + stats.capEvictions
          + stats.expiredMemories + stats.nonLatestMemories) > 0) {
        await flushIndexSave();
      }

      // One batched audit row per run for the facet cascade, per the policy in
      // audit.ts:16-20. The per-object rows above stay as they are (a wave-2
      // decision); the cascade is new, so it follows the policy from the start.
      if (!dryRun && removedFacetIds.length > 0) {
        await recordAudit(kv, "delete", "mem::evict", removedFacetIds, {
          resource: "facet",
          reason: "cascade_target_evicted",
          dryRun,
        });
      }

      logger.info("Eviction complete", { stats });
      return stats;
    },
  );
}
