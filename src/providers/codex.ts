import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Codex, CodexOptions, ThreadOptions } from "@openai/codex-sdk";
import type { MemoryProvider, ProviderConfig } from "../types.js";
import { resolveDataDir } from "../cli-data-dir.js";
import { getEnvVar } from "../config.js";
import { bootWarn, logger } from "../logger.js";

type CodexSdkModule = typeof import("@openai/codex-sdk");

/**
 * Sentinel, NOT a Codex model name. `ProviderConfig.model` is a required
 * string (types.ts:144), but the model of a Codex turn actually comes from the
 * user's own ~/.codex/config.toml, and the binary ships no built-in default:
 * neither `Turn` nor the NDJSON stream carries a model field. Pinning a real
 * model literal would send a model the user's plan may not include — the #778
 * failure mode. Consumers MUST compare against this constant (one place, never
 * a literal repeated per call site) and, on a match, omit `model` from the
 * thread options so Codex resolves it.
 *
 * It lives HERE, next to its only consumer (`threadOptions()` below), and not
 * in `./index.js`: a provider must not import from the factory that constructs
 * it. `providers/index.ts` re-exports it, so the name callers already use is
 * unchanged.
 */
export const CODEX_DEFAULT_MODEL = "codex-default";

/**
 * The ONLY variables of THIS process handed to the `codex exec` child. One
 * more variable is added to the child on top of this list and is not read from
 * here: the recursion marker, see `SDK_CHILD_MARKER`.
 *
 * Allowlist, never a denylist. `src/config.ts:82` merges `~/.agentmemory/.env`
 * into `process.env`, so this process holds the API keys and tokens of every
 * other configured provider. The SDK inherits the full `process.env` unless
 * `CodexOptions.env` is supplied (`dist/index.js:233-242`), and the turn input
 * is built from untrusted observation text (`src/functions/compress.ts` feeds
 * file contents, command output and fetched pages into the prompt) while the
 * agent may run shell commands under `read-only` and has no human approval
 * gate. Inheriting the parent environment would therefore put every other
 * provider's secret one prompt-injection away from being read out of the
 * child's own environment. Nothing on this list is a credential of another
 * provider; Codex's own subscription credentials live in the user's home
 * directory, which is why HOME is here.
 *
 * A denylist would also break the grep invariant of this phase, which requires
 * the key/base-url variable names of the keyed provider family to appear
 * nowhere in this file.
 *
 * Residual, deliberately accepted: proxy variables may embed credentials in
 * their URL. They are forwarded because without them the provider cannot reach
 * the network at all behind a corporate proxy, and the failure would surface as
 * an opaque timeout.
 */
const CHILD_ENV_ALLOWLIST: readonly string[] = [
  // Binary lookup and shell resolution. The SDK prepends its own bundled
  // directories to whichever of these keys exists (`dist/index.js:474-492`).
  "PATH",
  "Path",
  // Codex reads its auth and config from the user's home directory.
  "HOME",
  "USERPROFILE",
  "CODEX_HOME",
  // Windows process essentials — a spawn without these fails outright.
  "APPDATA",
  "LOCALAPPDATA",
  "SystemRoot",
  "windir",
  "ComSpec",
  "PATHEXT",
  // Scratch space for the child itself (not our working directory).
  "TMPDIR",
  "TEMP",
  "TMP",
  // Text encoding of the NDJSON stream we parse back.
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  // Corporate egress.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  // Custom trust store, or TLS to the API fails with an unhelpful error.
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
];

/**
 * Layer C of the recursion guard: the marker every agentmemory lifecycle hook
 * already reads (`src/hooks/sdk-guard.ts:20-26`, 13 of the 15
 * `plugin/scripts/*.mjs`, 15 `src/hooks/*.ts`). No second marker is
 * introduced — the existing one is reused, so hooks that already short-circuit
 * on it need no change.
 *
 * It is needed on a vector the MCP override (layer A) does not see: the child
 * `codex exec` can start its OWN Codex session whose lifecycle hooks
 * (`plugin/hooks/hooks.codex.json`, six of them) POST observations back into
 * the agentmemory REST API. Those fire on CLI events, not on a model decision,
 * so disabling the MCP server does not stop them.
 */
const SDK_CHILD_MARKER = "AGENTMEMORY_SDK_CHILD";

/**
 * Layer D of the recursion guard, in-process. Mirrors `agent-sdk.ts:23`: the
 * marker below cannot carry this job because `summarize` runs its chunks
 * concurrently in ONE process via `Promise.all`
 * (`src/functions/summarize.ts:70,111,180`). A global flag flipped by the first
 * chunk made every sibling bail out as a "child" — defect #781,
 * `too_many_chunks_skipped: N/N`. An async-scoped frame does not leak into
 * siblings, so only true re-entry sees a store here.
 */
const codexChildContext = new AsyncLocalStorage<true>();

/**
 * Refcount for the `process.env` half of layer C, copied from
 * `agent-sdk.ts:25-33` including its reason: a per-call snapshot races across
 * overlapping calls. A saves prev=undefined, B saves prev="1", A's `finally`
 * restores undefined while B is still in flight (so any process B spawns
 * misses the marker), then B's `finally` restores "1" and leaks it into the
 * global environment after the last caller is gone. Only the first entrant
 * snapshots and only the last exit restores.
 */
let codexActiveCount = 0;
let codexOriginalMarker: string | undefined;

/** Reads `process.env` directly: the allowlist must be evaluated against the
 * real environment of this process, and every key on it is absent from the
 * `.env` overlay by construction. */
function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }
  // Set unconditionally, NOT copied from `process.env`: supplying
  // `CodexOptions.env` stops the SDK from inheriting `process.env` into the
  // child at all (`dist/index.js:233-242`), so a marker that merely happened to
  // be set in this process would not reach the child on its own. Every child
  // this file spawns is by definition our child, so the value is constant "1"
  // rather than a snapshot of the parent's transient state — a snapshot would
  // make layer C depend on WHEN the SDK object was built, and losing it is
  // silent: the call still succeeds, only the child's hooks recurse.
  env[SDK_CHILD_MARKER] = "1";
  return env;
}

/**
 * 🔴 DO NOT DELETE THIS COMMAND. It is never executed and that is exactly why
 * it looks removable — removing it breaks the provider outright for every user
 * who has not run `agentmemory connect codex`.
 *
 * `--config` MERGES into `~/.codex/config.toml` instead of replacing it, so on
 * a machine where `[mcp_servers.agentmemory]` does not exist the override
 * CREATES the entry. An entry with neither `command` nor `url` has no
 * transport, and Codex then refuses to load the config as a whole:
 *
 *   Error: failed to load configuration
 *   Caused by: invalid transport in `mcp_servers.agentmemory`
 *
 * — exit 1, before any network call, i.e. no turn happens at all. Measured on
 * the pinned binary 0.146.1 with `env -i` + PATH only, `codex mcp list`:
 *
 *   HOME empty, no override                 exit 0  "No MCP servers configured yet"
 *   HOME empty, `enabled=false` alone       exit 1  invalid transport
 *   HOME with a FOREIGN server only, same   exit 1  invalid transport   <- the boundary
 *   any of the three, with this stub        exit 0  agentmemory disabled, neighbours enabled
 *
 * The boundary of the defect is "no `[mcp_servers.agentmemory]` entry", NOT
 * "no config file": a config that holds somebody else's server fails just the
 * same. That state is unreachable on a machine where `connect codex` has been
 * run, which is why every earlier measurement of this override missed it.
 *
 * The value is self-explaining on purpose: if it ever surfaces in
 * `codex mcp list` or in somebody's log, it names its own reason.
 */
const MCP_DISABLED_STUB_COMMAND = "agentmemory-disabled-by-provider";

/**
 * Layer A of the recursion guard, deterministic, closes the MCP vector. The
 * SDK flattens this object into
 * `--config mcp_servers.agentmemory.command="…"` plus
 * `--config mcp_servers.agentmemory.enabled=false`
 * (`dist/index.js:306-345`, `serializeConfigOverrides` / `toTomlValue`).
 *
 * Measured with `codex mcp list` under the live HOME: without the override the
 * server is `enabled`; with it, `disabled`, while neighbouring servers stay
 * `enabled` (positive control — the override changes one row, not the table).
 * A third run proved the tempting shortcut wrong: `mcp_servers={}` leaves the
 * server `enabled`, because `--config` MERGES into the config instead of
 * replacing it. Blanking the whole table is not an option to fall back on.
 *
 * Side effect, named rather than hidden: on a machine where the entry DOES
 * exist this replaces the user's own `command` for the duration of this call.
 * Harmless while `enabled` is false — the command is never spawned, the file on
 * disk is untouched, and `--config` lives only in our own child process — but
 * it is more than "one field flipped", so it is written down.
 *
 * Residual risk, likewise named: this targets the server BY NAME — the name our
 * own adapter writes (`src/cli/connect/codex.ts:24,32`). A user who registered
 * the agentmemory MCP by hand under another name is covered only by the
 * approval policy below. The two layers overlap on purpose.
 */
const MCP_RECURSION_OVERRIDE: CodexOptions["config"] = {
  mcp_servers: {
    agentmemory: {
      // Stub transport — see MCP_DISABLED_STUB_COMMAND. Load-bearing, not decor.
      command: MCP_DISABLED_STUB_COMMAND,
      enabled: false,
    },
  },
};

// ---------------------------------------------------------------------------
// Child process lifecycle: timeout, cancellation on shutdown, concurrency cap,
// and the external sweeper for children that outlived their parent.
//
// Before this provider the worker daemon had NO child processes at all. Every
// call now costs a full OS process life (27 372 ms measured on a real
// `compress` prompt), and `compress` runs on every observation — so the worker
// almost always has a live child, and the ways the parent can die stop being
// hypothetical.
// ---------------------------------------------------------------------------

/**
 * Wall clock for one turn. 90 000 ms is 3x the worst measured SUCCESS on real
 * prompts (compress 27 372 ms, summarize 21 757 ms; an unauthorized refusal
 * costs 28 267 ms) — chosen from measurement, not for roundness:
 *   - under 60 s healthy long turns get cut: the spread was already +-18% on a
 *     one-word prompt (8 556-10 055 ms);
 *   - over 120 s `compressWithRetry(..., maxRetries = 1)`
 *     (`src/eval/self-correct.ts:7-27`) spends more than four minutes on ONE
 *     observation, and the circuit breaker's three failures
 *     (`circuit-breaker.ts:24-29`) then take twelve minutes to open.
 *
 * Env-overridable so O-2 — the still-unbounded latency of a chunked
 * `summarize` — can be answered by configuration instead of a code change.
 */
const CODEX_TIMEOUT_ENV = "AGENTMEMORY_CODEX_TIMEOUT_MS";
const CODEX_DEFAULT_TIMEOUT_MS = 90_000;

/**
 * Ceiling on simultaneously live `codex exec` children.
 *
 * Default 1, deliberately conservative: `compress` is dispatched
 * fire-and-forget (`src/functions/observe.ts:288-296`,
 * `TriggerAction.Void()`), observations arrive in bursts, and without a cap a
 * burst of N observations means N OS processes, each with its own network
 * connection and memory. It also bounds the damage of a SIGKILL'ed parent: one
 * orphan instead of a whole burst.
 *
 * Raising it is a measurement decision (`mem::summarize` avgLatency in
 * `/agentmemory/health`), not a guess: chunked `summarize` fans out through
 * `Promise.all` (`src/functions/summarize.ts:70,111,180`) and at 1 those chunks
 * queue up — slower, never rejected (see the semaphore below).
 */
const CODEX_CONCURRENCY_ENV = "AGENTMEMORY_CODEX_MAX_CONCURRENCY";
const CODEX_DEFAULT_MAX_CONCURRENCY = 1;

/** Non-positive and unparsable values fall back rather than being honoured: a
 * literal 0 would mean "never run anything" and would hang every call inside
 * the semaphore with no error to explain it. */
function positiveIntEnv(key: string, fallback: number): number {
  const raw = getEnvVar(key);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Every in-flight turn's controller. Module-scoped, not per instance: the
 * shutdown handler has to reach turns of every `CodexProvider` ever built in
 * this process, and `createFallbackProvider` can build more than one.
 */
const inFlightTurns = new Set<AbortController>();

/** Exported for the size assertion of the leak test: a controller that is never
 * removed shows up in nothing else — no error, no log, only unbounded growth. */
export function codexInFlightCount(): number {
  return inFlightTurns.size;
}

/**
 * Cancels every in-flight turn. Synchronous by design: the worker's SIGTERM
 * grace is 5000 ms (`src/cli.ts:2709`) and that budget is already spoken for by
 * the index flush (`DEBOUNCE_MS = 5000`, `src/state/index-persistence.ts:9`,
 * D-30). Waiting here for a 27-second turn to unwind would guarantee the grace
 * expires and turn a clean SIGTERM into the SIGKILL path.
 *
 * `abort()` reaches the child through `spawn(..., { signal })`
 * (`@openai/codex-sdk/dist/index.js:252-255`), which kills it; the turn then
 * rejects and the per-call `finally` removes the working directory.
 */
export function abortInFlightCodexTurns(): void {
  for (const controller of inFlightTurns) {
    try {
      controller.abort();
    } catch {
      // A shutdown path must never be the thing that throws.
    }
  }
}

let shutdownHooksInstalled = false;

/**
 * ADDITIVE registration, never `removeAllListeners`: the daemon installs its
 * own shutdown handler (`src/index.ts:682-683`) and it must keep running. The
 * only construction site of this provider is `src/index.ts:176-177`, i.e.
 * before that handler exists, so ours runs first on SIGTERM — abort initiates,
 * then the daemon's shutdown flushes and exits.
 *
 * Residual, named rather than hidden: Node suppresses its default "terminate on
 * SIGTERM" as soon as ANY listener exists. In a hypothetical process that
 * builds a CodexProvider and installs no shutdown handler of its own, this
 * listener alone would swallow the signal. That process does not exist today
 * (the switch above is reached only from the daemon), and self-terminating from
 * here would be exactly the "replace the existing shutdown" that this phase
 * forbids.
 */
function installShutdownHooks(): void {
  if (shutdownHooksInstalled) return;
  shutdownHooksInstalled = true;
  process.on("SIGTERM", abortInFlightCodexTurns);
  process.on("beforeExit", abortInFlightCodexTurns);
}

// --- semaphore -------------------------------------------------------------
//
// FIFO, and it never rejects a waiter: dropping an over-the-cap call would turn
// a throughput limit into a failure mode, and `compress` treats any throw as a
// provider failure that counts towards the circuit breaker.
let activeTurns = 0;
const waitingForSlot: Array<() => void> = [];

function acquireTurnSlot(): Promise<void> {
  const limit = positiveIntEnv(
    CODEX_CONCURRENCY_ENV,
    CODEX_DEFAULT_MAX_CONCURRENCY,
  );
  if (activeTurns < limit) {
    activeTurns++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    waitingForSlot.push(resolve);
  });
}

/** Hands the slot straight to the next waiter instead of decrementing and
 * letting it re-check: the re-check would race with a fresh caller and starve
 * the queue. The limit is re-read on every acquire, so raising it takes effect
 * for calls that arrive afterwards, not for those already queued. */
function releaseTurnSlot(): void {
  const next = waitingForSlot.shift();
  if (next) {
    next();
    return;
  }
  activeTurns--;
}

async function withTurnSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquireTurnSlot();
  try {
    return await fn();
  } finally {
    releaseTurnSlot();
  }
}

// --- external sweeper ------------------------------------------------------

const execFileAsync = promisify(execFile);

/** `<dataDir>/tmp/codex` — resolved per call, not cached: `resolveDataDir()`
 * reads argv and env, and tests move the data dir underneath us. */
function codexTmpRoot(): string {
  const { dataDir } = resolveDataDir();
  return join(dataDir, "tmp", "codex");
}

/** Same predicate as `src/cli.ts:2502-2509`: EPERM means the pid exists and
 * belongs to someone else, which is still "alive". */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

/** `pgrep -f` takes an ERE, and a data dir may legitimately contain `.`, `+`
 * or brackets. An unescaped path is a pattern that matches more than the path. */
function escapeEre(value: string): string {
  return value.replace(/[.[\]{}()*+?^$|\\]/g, "\\$&");
}

async function pidsWithCommandLine(pattern: string): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync("pgrep", ["-f", escapeEre(pattern)], {
      timeout: 5_000,
    });
    return stdout
      .split("\n")
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isInteger(pid) && pid > 1);
  } catch (error) {
    // pgrep exits 1 when nothing matched — the common case, not an error.
    if ((error as { code?: unknown })?.code === 1) return [];
    throw error;
  }
}

const KILL_ESCALATION_MS = 250;

/**
 * Kills whatever still holds `directory` as its `--cd`. The ownership marker is
 * the command line of the child itself (the SDK passes the working directory as
 * `--cd`, `@openai/codex-sdk/dist/index.js:174-232`), which is why a reused pid
 * cannot be mistaken for ours: the path names the parent that created it, and a
 * process that merely inherited that number never carries the string.
 */
async function killProcessesUnder(directory: string): Promise<number> {
  let pids: number[];
  try {
    pids = await pidsWithCommandLine(directory);
  } catch (error) {
    // No pgrep (Windows) or it failed: say so instead of leaving the caller to
    // believe the tree was cleaned.
    logger.warn("codex sweep: could not enumerate processes for directory", {
      directory,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }

  const targets = pids.filter((pid) => pid !== process.pid);
  if (targets.length === 0) return 0;

  for (const pid of targets) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone, or not ours to signal.
    }
  }
  await new Promise((resolve) => setTimeout(resolve, KILL_ESCALATION_MS));
  for (const pid of targets) {
    if (!isPidAlive(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Same.
    }
  }
  return targets.length;
}

/**
 * Startup sweep of `<dataDir>/tmp/codex/<parent pid>/`.
 *
 * Why it exists even though it will usually find nothing: an orphaned child was
 * measured to die on its own within seconds (it dies writing to a stdout nobody
 * reads), and launchd brings the worker back in about the same time. It is here
 * for the case whose upper bound is NOT established — a turn sitting silent in
 * stdout while it waits on the network outlives a worker restart. Reading
 * "it always finds zero" as "dead code" and deleting it is the mistake this
 * program already paid for once (D-3(a)).
 *
 * Conversely, if it regularly finds non-empty trees that is a signal the
 * per-call `finally` is not running — not "as designed".
 */
export async function sweepOrphanedCodexRuns(): Promise<void> {
  const root = codexTmpRoot();
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    // ENOENT is the normal first-run state.
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      logger.warn("codex sweep: cannot read the working-directory root", {
        root,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  const unrecognized: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pid = Number.parseInt(entry.name, 10);
    if (!Number.isInteger(pid) || pid <= 0 || String(pid) !== entry.name) {
      // Not a pid directory, so it carries no ownership information at all and
      // cannot be proven dead. Left in place, but never silently.
      unrecognized.push(entry.name);
      continue;
    }
    // A live pid may be a parallel instance of the daemon. Touching its tree
    // would kill ITS children.
    if (pid === process.pid || isPidAlive(pid)) continue;

    const directory = join(root, entry.name);
    try {
      const killed = await killProcessesUnder(directory);
      await rm(directory, { recursive: true, force: true });
      logger.warn("codex sweep: removed the tree of a dead parent", {
        directory,
        killedProcesses: killed,
      });
    } catch (error) {
      logger.warn("codex sweep: failed to clean the tree of a dead parent", {
        directory,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (unrecognized.length > 0) {
    logger.warn("codex sweep: left directories with no parent pid in the name", {
      root,
      entries: unrecognized.join(","),
    });
  }
}

let sweepStarted = false;

/** Fire-and-forget, once per process: the sweep spawns `pgrep` and must not
 * delay provider construction, which sits on the daemon's boot path. */
function startSweepOnce(): void {
  if (sweepStarted) return;
  sweepStarted = true;
  void sweepOrphanedCodexRuns().catch((error) => {
    logger.warn("codex sweep: failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

// --- diagnosis: authorization and installation --------------------------
//
// Three outcomes leave `runTurn` through ONE catch, and the order of the tests
// is fixed here:
//   1. our own timer fired               -> codex_timeout       (see above)
//   2. the throw came out of `getCodex`  -> codex_bad_install   (POSITIONAL)
//   3. `401`/`Unauthorized` in the text  -> codex_unauthorized
//
// (1) is the state of our own object and therefore outranks any text: the
// reverse order would report "not signed in" on every timeout the day upstream
// starts writing `401` into the text of an interrupted turn. (2) precedes (3)
// because it is exact — a position in the code — while (3) is a substring
// match.
//
// This is the LAST place where the three are distinguishable at all:
// `fallback-chain.ts:18-30` stores every exception in `lastError` without
// logging a line and hands only the last one out, and `ResilientProvider`
// counts any exception as one failure.

/**
 * The platform package the SDK would look for on THIS runtime. Copied from
 * `@openai/codex-sdk/dist/index.js:147-154` plus the triple switch at
 * `:382-424` — deliberately duplicated rather than imported, because the SDK
 * exports neither.
 *
 * It exists because the upstream error our case produces (`dist/index.js:440`,
 * `Unable to locate Codex CLI binaries. Ensure ...`) names NEITHER the module
 * nor the architecture: `:434-437` keeps both `resolve` calls inside one `try`,
 * so a vendor tree of the wrong architecture fails there. Of the four throws in
 * `findCodexPath` (`:427,431,440,447`) only two carry an architecture, and none
 * carries the module name.
 */
const CODEX_PLATFORM_PACKAGE_BY_TARGET: Readonly<Record<string, string>> = {
  "x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
  "aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",
  "x86_64-apple-darwin": "@openai/codex-darwin-x64",
  "aarch64-apple-darwin": "@openai/codex-darwin-arm64",
  "x86_64-pc-windows-msvc": "@openai/codex-win32-x64",
  "aarch64-pc-windows-msvc": "@openai/codex-win32-arm64",
};

function codexTargetTriple(): string | undefined {
  const arch =
    process.arch === "x64"
      ? "x86_64"
      : process.arch === "arm64"
        ? "aarch64"
        : undefined;
  if (!arch) return undefined;
  switch (process.platform) {
    case "linux":
    case "android":
      return `${arch}-unknown-linux-musl`;
    case "darwin":
      return `${arch}-apple-darwin`;
    case "win32":
      return `${arch}-pc-windows-msvc`;
    default:
      return undefined;
  }
}

/** 🔴 The name is COMPUTED BY US from `process.platform`/`process.arch`. It
 * does NOT come from the SDK's error text and must never be read as if it did:
 * a later reader who assumes otherwise would build a check on a string upstream
 * never emits. */
function expectedPlatformPackage(): string {
  const triple = codexTargetTriple();
  const platformPackage = triple
    ? CODEX_PLATFORM_PACKAGE_BY_TARGET[triple]
    : undefined;
  return (
    platformPackage ?? `no platform package for ${process.platform}/${process.arch}`
  );
}

/**
 * The only machine-readable signal the contract offers for "no session":
 * `ThreadError` (`dist/index.d.ts:138-141`) is `{message: string}` — no code,
 * no type — and the CLI performs no local session check at all, it posts to
 * `api.openai.com` and relays the server's 401.
 *
 * When upstream rewords it, the match stops firing. That degrades towards LESS
 * information, never towards a false success: the call still throws, the
 * failure is still recorded, the breaker still opens; only the "sign in" hint
 * disappears. Which is exactly why nothing here may DECIDE anything on this
 * signal — it selects wording, never an outcome.
 */
function looksUnauthorized(message: string): boolean {
  const lowered = message.toLowerCase();
  return lowered.includes("401") || lowered.includes("unauthorized");
}

/**
 * A constant, assembled from nothing the upstream response carried: the raw
 * text holds `cf-ray` and a request id, and although those are not secrets
 * there is no reason to drag another service's response into our log. It names
 * the SYMPTOM (401 from api.openai.com — so the user can tell this apart from a
 * model refusal and from a network error) and the ACTION, and it never
 * mentions the credential file as an object of action.
 */
const CODEX_UNAUTHORIZED_WARNING =
  "Codex provider: no ChatGPT/Codex session (HTTP 401 from api.openai.com). " +
  "Sign in with the Codex CLI, then restart agentmemory. " +
  "agentmemory neither asks for nor stores your credentials.";

/** Short and equally constant: this string travels up the stack, where
 * `fallback-chain.ts` may log or re-throw it. */
const CODEX_UNAUTHORIZED_ERROR =
  "codex_unauthorized: no Codex session (HTTP 401 from api.openai.com)";

/**
 * Wording only — the CLASSIFICATION is positional and has already happened by
 * the time this runs. Advising "sign in to Codex" to someone whose platform
 * package is missing is a false diagnosis that sends them the wrong way (the
 * D-31 class: a signal exists but points elsewhere), so the installation case
 * gets its own text naming the ARCHITECTURE rather than the session.
 */
function badInstallDetail(message: string): string {
  if (message.includes("Unsupported platform")) {
    // `dist/index.js:427`/`:431`. Reinstalling cannot help, and the text has to
    // say so instead of sending the user round a loop.
    return (
      `Codex does not support this platform (${process.platform}/${process.arch}). ` +
      "Reinstalling will not help — use another LLM provider on this machine."
    );
  }
  if (message.includes("Unable to locate Codex CLI binaries")) {
    // `dist/index.js:440`/`:447` — the D-18 case. The module name below is OURS
    // (see `expectedPlatformPackage`), the upstream text carries none.
    return (
      `platform package missing — ${expectedPlatformPackage()} ` +
      "(expected for this runtime, computed locally). The installed " +
      "@openai/codex-sdk does not match this runtime's architecture " +
      `(${process.platform}/${process.arch}). Reinstall agentmemory with npm ` +
      "running under the same node the daemon uses, passing --prefix for that " +
      "node explicitly."
    );
  }
  // Anything else the constructor may ever throw. The raw text is passed
  // through HERE and only here: it comes from module resolution inside our own
  // process, never from an HTTP response, so it carries no upstream body and no
  // credential — unlike the 401 text above, which is never copied.
  return `Codex CLI unavailable: ${message}`;
}

/**
 * Two flags, deliberately NOT one. A shared flag would pass the "the same
 * condition twice prints once" test unchanged and silently swallow the second
 * diagnosis — the case only a pair of DIFFERENT conditions can tell apart.
 *
 * Module-scoped, i.e. once per process: `compress` runs on every observation
 * and an unauthorized user produces one failure per observation, so a per-call
 * warning would flood the daemon log.
 */
let unauthorizedWarned = false;
let badInstallWarned = false;

/** `bootWarn`, not `bootLog`: in quiet mode (the default) `bootLog`
 * (`logger.ts:88-98`) buffers the line and returns, so this message would reach
 * nobody on the live daemon. `bootWarn` (`logger.ts:100-106`) always writes to
 * stderr. */
function warnUnauthorizedOnce(): void {
  if (unauthorizedWarned) return;
  unauthorizedWarned = true;
  bootWarn(CODEX_UNAUTHORIZED_WARNING);
}

function warnBadInstallOnce(detail: string): void {
  if (badInstallWarned) return;
  badInstallWarned = true;
  bootWarn(`Codex provider: ${detail}`);
}

/**
 * Keyless provider backed by the user's ChatGPT subscription. The SDK spawns
 * `codex exec` per turn and talks NDJSON over its stdio — we never spawn the
 * binary ourselves.
 *
 * `describeImage` is intentionally absent: `src/functions/compress.ts:84`
 * checks for the method before calling it, so an observation with an image
 * still compresses, only without `imageDescription`.
 */
export class CodexProvider implements MemoryProvider {
  name = "codex";

  private readonly model: string;

  // Memoize the dynamic import so concurrent callers share one resolution
  // instead of racing to resolve the specifier independently. Mirrors
  // agent-sdk.ts:43-50. Not cosmetic here: the platform blob behind
  // `@openai/codex-sdk` is ~324 MB, and resolving it from the constructor
  // would land in the cold start of every user, including those on another
  // provider.
  private sdkPromise: Promise<CodexSdkModule> | null = null;

  // One `Codex` per provider instance, a NEW `Thread` per call. `startThread()`
  // does no I/O, while every `run()` spawns its own process — so reusing a
  // thread buys no latency (measured 8 556-10 055 ms either way) and only
  // grows `input_tokens` (15 109 -> 30 361 -> 45 633), i.e. cost.
  // Thread resumption is never used.
  // (Wording is deliberate: this file must contain no `resume`+`Thread`
  // literal, so the invariant grep for it stays a zero-vs-nonzero signal.)
  private codexPromise: Promise<Codex> | null = null;

  constructor(config: ProviderConfig) {
    this.model = config.model;
    // Both are process-wide and idempotent, so building a second provider (the
    // fallback chain does) neither duplicates the listeners nor re-runs the
    // sweep. Neither may throw: this runs on the daemon's boot path.
    installShutdownHooks();
    startSweepOnce();
  }

  async compress(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.query(systemPrompt, userPrompt);
  }

  async summarize(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.query(systemPrompt, userPrompt);
  }

  private loadSdk(): Promise<CodexSdkModule> {
    if (!this.sdkPromise) {
      this.sdkPromise = import("@openai/codex-sdk");
    }
    return this.sdkPromise;
  }

  private getCodex(): Promise<Codex> {
    if (!this.codexPromise) {
      // `CodexOptions.apiKey` and `CodexOptions.baseUrl` are NEVER passed,
      // and this file reads no environment variable of the OpenAI key/base-url
      // family at all. On a live install those variables can hold a DeepSeek
      // key and api.deepseek.com (they belong to the keyed chat provider, not
      // to this one); forwarding either would silently route a "Codex" turn
      // somewhere else and make a wrong answer look like a working provider.
      // The invariant is checked by grep, so the literal names are spelled out
      // nowhere in this file — not even in a comment.
      //
      // `env` is passed for the same reason in its stronger form: supplying it
      // stops the SDK from copying `process.env` into the child at all
      // (`dist/index.js:233-242`), so the omission above cannot be undone by
      // inheritance. See CHILD_ENV_ALLOWLIST.
      //
      // A REJECTION IS CACHED TOO, and that is a decision, not an oversight.
      // `new Codex(...)` builds `CodexExec`, whose constructor calls
      // `findCodexPath()` (`dist/index.js:161-168`, `:514`) — the one place a
      // broken installation surfaces. `compress` runs on every observation, so
      // not caching the rejection would make every observation pay for the
      // constructor again. Recovering from a fixed installation therefore needs
      // a daemon restart, which installing a package needs anyway.
      this.codexPromise = this.loadSdk().then(
        ({ Codex }) =>
          new Codex({ env: childEnv(), config: MCP_RECURSION_OVERRIDE }),
      );
    }
    return this.codexPromise;
  }

  private async query(systemPrompt: string, userPrompt: string): Promise<string> {
    // Layer D. Re-entry from inside our own async call tree — a hook or an SDK
    // callback calling back into compress/summarize — must not spawn a second
    // `codex exec`. Concurrent siblings are NOT re-entry: each `Promise.all`
    // branch gets its own frame below, so this branch is unreachable for them
    // (#781).
    if (codexChildContext.getStore()) {
      return "";
    }

    // Nesting is fixed here and is not free choice: SEMAPHORE OUTSIDE, ALS
    // FRAME INSIDE. Inverted, a call parked in the semaphore queue would hold
    // an open ALS frame and (through `runGuarded`) the `process.env` marker's
    // refcount for the whole wait, so `AGENTMEMORY_SDK_CHILD` would stay set in
    // this process far longer than any real call is running.
    //
    // The re-entry check above stays outside BOTH. Inside the semaphore it
    // would deadlock at the default cap of 1: the re-entrant call would wait
    // for the slot its own caller is holding.
    return withTurnSlot(() =>
      codexChildContext.run(true, () =>
        this.runGuarded(systemPrompt, userPrompt),
      ),
    );
  }

  /** Runs one turn with the recursion marker held on `process.env` for the
   * whole call. Split out of `query` only so the guard's early exit stays one
   * readable branch. */
  private async runGuarded(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<string> {
    // Layer C, parent half: in-process hook code and anything else spawned
    // while this call is in flight reads the marker off `process.env`. The
    // child's own copy does not come from here — see `childEnv()`.
    if (codexActiveCount === 0) {
      codexOriginalMarker = process.env[SDK_CHILD_MARKER];
      process.env[SDK_CHILD_MARKER] = "1";
    }
    codexActiveCount++;

    try {
      return await this.runTurn(systemPrompt, userPrompt);
    } finally {
      codexActiveCount--;
      if (codexActiveCount === 0) {
        if (codexOriginalMarker === undefined) {
          delete process.env[SDK_CHILD_MARKER];
        } else {
          process.env[SDK_CHILD_MARKER] = codexOriginalMarker;
        }
        codexOriginalMarker = undefined;
      }
    }
  }

  private async runTurn(systemPrompt: string, userPrompt: string): Promise<string> {
    // One controller per call, created AFTER the semaphore slot is held so the
    // queue wait does not eat the turn's budget. Per call, never shared: a
    // shared controller would let one call's timeout cancel its siblings, which
    // under a chunked `summarize` means one slow chunk killing all of them.
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, positiveIntEnv(CODEX_TIMEOUT_ENV, CODEX_DEFAULT_TIMEOUT_MS));
    timer.unref();
    inFlightTurns.add(controller);

    // 🔴 The classifier of a broken installation. It is POSITIONAL, not
    // textual: this flag is raised the instant `getCodex()` resolves, so any
    // throw seen with it still down came out of the SDK constructor. That
    // closes the family whole — all four throws of `findCodexPath`
    // (`dist/index.js:427,431,440,447`) plus any future constructor failure —
    // without depending on upstream wording. A substring match on
    // `Unable to locate Codex CLI binaries` would cover only two of the four
    // and misfile the rest as a model failure or as a 401.
    let codexReady = false;
    let workingDirectory: string | undefined;

    try {
      // Inside the SAME handler as the turn call below on purpose: before this
      // phase `getCodex()` was awaited outside it, so a broken installation
      // never passed through this catch at all and no wording could have caught
      // it.
      // (Wording is deliberate: the literal of the turn-call expression appears
      // in this file exactly once, on the call itself, so the И-4.1 grep stays a
      // signal about code rather than about prose — see the note in the report.)
      const codex = await this.getCodex();
      codexReady = true;
      workingDirectory = await this.createWorkingDirectory();
      const thread = codex.startThread(this.threadOptions(workingDirectory));
      // Codex has NO system role: a turn takes a single input and
      // `ThreadOptions` carries no `systemPrompt`. The two contract arguments
      // are joined here, in exactly one place — the plan's latency figures
      // (27 372 ms / 21 757 ms) were measured on this exact join.
      //
      // `signal` is the whole point of the phase: without it nothing in the
      // stack bounds a turn (`resilient.ts` has no timeout, and `codex exec`
      // has no self-limit option), and nothing can kill the child on shutdown.
      const turn = await thread.run(`${systemPrompt}\n\n${userPrompt}`, {
        signal: controller.signal,
      });
      // Reachable only if the SDK resolves a turn whose child we already had
      // killed. The answer came from a process under a kill signal, so it is
      // not a result we may return as success.
      if (timedOut) throw new Error("codex_timeout");
      // A successful `Turn` carries no error field at all — a failed turn
      // throws instead.
      return turn.finalResponse;
    } catch (error) {
      // (1) Only OUR timer maps to `codex_timeout`. An abort that came from the
      // shutdown handler is not a timeout, and the SDK's own error
      // ("Codex Exec exited with signal ...") is passed through unchanged.
      // First because it is the state of our own object: any text-based test
      // placed above it would mislabel a timeout the day upstream writes `401`
      // into the text of an interrupted turn.
      if (timedOut) throw new Error("codex_timeout");

      const message = error instanceof Error ? error.message : String(error);

      // (2) Positional: the constructor never ran to completion.
      if (!codexReady) {
        const detail = badInstallDetail(message);
        warnBadInstallOnce(detail);
        throw new Error(`codex_bad_install: ${detail}`);
      }

      // (3) Substring, and last. Note what does NOT happen here: the call is
      // not turned into a success and "" is not returned. Recognising a 401
      // changes the WORDING, never the outcome — a returned "" would look like
      // an empty answer, sail past the breaker, and leave the user waiting
      // instead of getting the 30-second pause.
      if (looksUnauthorized(message)) {
        warnUnauthorizedOnce();
        throw new Error(CODEX_UNAUTHORIZED_ERROR);
      }

      throw error;
    } finally {
      clearTimeout(timer);
      // Before the directory removal, and unconditional: a controller left in
      // the set leaks silently — nothing observes it except the set's own size.
      inFlightTurns.delete(controller);
      try {
        // Undefined only when the SDK constructor threw first, i.e. on the
        // `codex_bad_install` path, where no directory was ever created.
        if (workingDirectory !== undefined) {
          await rm(workingDirectory, { recursive: true, force: true });
        }
      } catch (error) {
        // Never let cleanup mask the turn's own error — but never let a leaked
        // directory be silent either. Ф4's external sweeper keys on this same
        // path, and a warn line is the only way to tell "swept later" from
        // "never created" when the tree under <dataDir>/tmp/codex grows.
        logger.warn("codex: failed to remove temp working directory", {
          workingDirectory,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private threadOptions(workingDirectory: string): ThreadOptions {
    const options: ThreadOptions = {
      // We want text back, not edits: writes are blocked under `read-only`.
      //
      // Scope of the guarantee, measured in research §5 and accepted as-is by
      // this phase: `read-only` blocks WRITES. Shell execution and reads of
      // paths outside the working directory are NOT blocked, and the turn input
      // contains untrusted observation text. Two things narrow that: the
      // working directory is a freshly created empty tree under <dataDir>, so
      // the user's own code is not in view by default, and the child's
      // environment is an allowlist with no other provider's credential in it.
      // What remains unblocked is reading files the daemon's uid can read.
      // Codex exposes no read-confinement mode, so this cannot be closed here;
      // the guard against reaching this code path at all is Ф3/Ф6.
      sandboxMode: "read-only",
      workingDirectory,
      // A fresh temp directory is not a git repository.
      skipGitRepoCheck: true,
      // Layer B of the recursion guard, behavioural and independent of the
      // server's NAME (unlike layer A). Headless, "never" resolves an approval
      // request into a refusal rather than a wait: measured on a live pair with
      // identical PATH and identical policy, differing only in the MCP
      // override — with MCP on, the turn carried
      // `mcp_tool_call status=failed, error="user cancelled MCP tool call"` in
      // 18 205 ms; with the override on, no `mcp_tool_call` item existed at all.
      // So it also removes the functional objection that a headless turn would
      // hang waiting for an approval nobody can give.
      //
      // Behavioural, not contractual: the SDK documents no such guarantee and
      // `ApprovalMode` lists four values with no semantics attached. If upstream
      // ever turns "never" into "approve automatically", layer A still holds —
      // which is why both exist.
      approvalPolicy: "never",
      // `compress` has no business searching the web — it costs money and
      // widens the latency spread.
      webSearchMode: "disabled",
      // `networkAccessEnabled` is deliberately NOT set: the SDK maps it to
      // `sandbox_workspace_write.network_access` (`dist/index.js:209-214`),
      // which only applies to the `workspace-write` sandbox. Setting it under
      // `read-only` would be an inert flag that reads like a control.
    };
    // The sentinel means "no model was pinned" — omit the option entirely so
    // Codex resolves the model from the user's own ~/.codex/config.toml
    // instead of being handed a literal their plan may not include.
    if (this.model !== CODEX_DEFAULT_MODEL) {
      options.model = this.model;
    }
    return options;
  }

  /**
   * A fresh working directory per call, under the resolved data dir rather
   * than the system `$TMPDIR`: otherwise Codex would see the user's own
   * working directory and read their code during `compress`.
   *
   * The layout `<dataDir>/tmp/codex/<parent pid>/<call>` is load-bearing, not
   * cosmetic. The SDK hands this path to the child as `--cd`
   * (`@openai/codex-sdk/dist/index.js:174-232`), so it appears in the child's
   * command line — and that makes the tree itself the registry of children,
   * with no separate pid file to keep in sync. A pid file was considered and
   * rejected: on its own it cannot tell a reused pid from ours, so it needs a
   * second marker anyway, i.e. it collapses into this scheme plus one more file
   * that can go stale.
   */
  private async createWorkingDirectory(): Promise<string> {
    const parentDirectory = join(codexTmpRoot(), String(process.pid));
    await mkdir(parentDirectory, { recursive: true });
    return mkdtemp(join(parentDirectory, "call-"));
  }
}
