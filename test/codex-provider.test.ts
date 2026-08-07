import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

// Recursion guard of the codex provider (wave 4, phase 3). Four layers, one
// vector each:
//   A  CodexOptions.config -> mcp_servers.agentmemory = stub command +
//      enabled=false                                                 (MCP)
//   B  ThreadOptions.approvalPolicy = "never"                        (behaviour)
//   C  AGENTMEMORY_SDK_CHILD in the CHILD's env and in process.env   (hooks)
//   D  AsyncLocalStorage                                             (in-process)
//
// Phase 4 adds the child process lifecycle (timeout, shutdown cancellation,
// concurrency cap, startup sweeper) in the second describe block below.
//
// vi.mock is hoisted above module-scope bindings, so the mock's mutable state
// is declared with vi.hoisted alongside it (same shape as
// test/agent-sdk-provider.test.ts).
const state = vi.hoisted(() => ({
  codexOptions: [] as Array<Record<string, any>>,
  threadOptions: [] as Array<Record<string, any>>,
  runInputs: [] as string[],
  // Phase 4: the TurnOptions of each call, and the peak number of turns the
  // mock ever saw running at the same moment.
  turnOptions: [] as Array<Record<string, any> | undefined>,
  activeRuns: 0,
  peakActiveRuns: 0,
  // Phase 5: what `new Codex(...)` throws, if anything. The real constructor
  // builds `CodexExec`, which calls `findCodexPath()`
  // (`@openai/codex-sdk/dist/index.js:161-168,514`) — the single place a broken
  // installation surfaces, and it is NOT reachable through `thread.run()`.
  constructorError: null as Error | null,
  onRun: null as
    | null
    | ((
        input: string,
        turnOptions?: Record<string, any>,
      ) => string | Promise<string>),
}));

vi.mock("@openai/codex-sdk", () => ({
  Codex: class {
    constructor(options: Record<string, any>) {
      state.codexOptions.push(options);
      if (state.constructorError) throw state.constructorError;
    }
    startThread(options: Record<string, any>) {
      state.threadOptions.push(options);
      return {
        async run(input: string, turnOptions?: Record<string, any>) {
          state.runInputs.push(input);
          state.turnOptions.push(turnOptions);
          state.activeRuns++;
          state.peakActiveRuns = Math.max(
            state.peakActiveRuns,
            state.activeRuns,
          );
          try {
            const finalResponse = state.onRun
              ? await state.onRun(input, turnOptions)
              : "<result>ok</result>";
            return { finalResponse };
          } finally {
            state.activeRuns--;
          }
        },
      };
    }
  },
}));

import {
  CodexProvider,
  abortInFlightCodexTurns,
  codexInFlightCount,
  sweepOrphanedCodexRuns,
} from "../src/providers/codex.js";
import { CODEX_DEFAULT_MODEL } from "../src/providers/index.js";

const TIMEOUT_ENV = "AGENTMEMORY_CODEX_TIMEOUT_MS";
const CONCURRENCY_ENV = "AGENTMEMORY_CODEX_MAX_CONCURRENCY";

function resetState() {
  state.codexOptions.length = 0;
  state.threadOptions.length = 0;
  state.runInputs.length = 0;
  state.turnOptions.length = 0;
  state.activeRuns = 0;
  state.peakActiveRuns = 0;
  state.constructorError = null;
  state.onRun = null;
}

function signalOf(index: number): AbortSignal | undefined {
  return state.turnOptions[index]?.signal as AbortSignal | undefined;
}

function workingDirectoryOf(index: number): string {
  return state.threadOptions[index]?.workingDirectory as string;
}

/** What the SDK really does when the turn's AbortSignal fires: `spawn` kills
 * the child and the exec loop throws on the non-zero exit
 * (`@openai/codex-sdk/dist/index.js:252-255,288-295`). */
function sdkAbortError(): Error {
  return new Error("Codex Exec exited with signal SIGTERM: ");
}

/**
 * A turn that only ever ends by cancellation. If the provider fails to pass a
 * signal this promise never settles at all — the test then dies on vitest's own
 * timeout, which is a DIFFERENT report line from "rejected with codex_timeout"
 * and must not be confused with a pass.
 */
function hangUntilAborted(
  _input: string,
  turnOptions?: Record<string, any>,
): Promise<string> {
  return new Promise<string>((_resolve, reject) => {
    const signal = turnOptions?.signal as AbortSignal | undefined;
    if (!signal) return;
    if (signal.aborted) {
      reject(sdkAbortError());
      return;
    }
    signal.addEventListener("abort", () => reject(sdkAbortError()));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

function newProvider() {
  return new CodexProvider({
    provider: "codex",
    model: CODEX_DEFAULT_MODEL,
    maxTokens: 1024,
  });
}

let dataDir: string;
let previousDataDir: string | undefined;

beforeAll(() => {
  // Keep the per-call working directories out of the developer's real data
  // dir: the provider creates <dataDir>/tmp/codex/call-* on every turn.
  previousDataDir = process.env.AGENTMEMORY_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), "codex-guard-test-"));
  process.env.AGENTMEMORY_DATA_DIR = dataDir;
});

afterAll(() => {
  if (previousDataDir === undefined) {
    delete process.env.AGENTMEMORY_DATA_DIR;
  } else {
    process.env.AGENTMEMORY_DATA_DIR = previousDataDir;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe("CodexProvider recursion guard", () => {
  beforeEach(() => {
    resetState();
    delete process.env.AGENTMEMORY_SDK_CHILD;
    // Phase 4 caps concurrency at 1 by default. Left at that default the
    // "full overlap of concurrent calls" test below would stop overlapping
    // anything: the calls would queue in the semaphore, and the per-call
    // snapshot it exists to reject would pass it just as well. The guard tests
    // therefore pin a cap that cannot serialize them.
    process.env[CONCURRENCY_ENV] = "8";
  });

  afterEach(() => {
    delete process.env.AGENTMEMORY_SDK_CHILD;
    delete process.env[CONCURRENCY_ENV];
  });

  // ---- layer A -----------------------------------------------------------
  it("disables the agentmemory MCP server for the child process (И-3.1)", async () => {
    const provider = newProvider();
    await provider.compress("sys", "user");

    expect(state.codexOptions.length).toBe(1);
    // Distinguishing: without the override this whole path is `undefined`,
    // and the turn still succeeds — which is exactly why the assertion is on
    // the option and not on the call's outcome.
    const entry = state.codexOptions[0].config?.mcp_servers?.agentmemory;
    expect(entry?.enabled).toBe(false);
    // BOTH fields, and the second one is not decoration. An override carrying
    // only `enabled` passes an `enabled === false` assertion in full while
    // breaking config loading (exit 1, `invalid transport`) for every user with
    // no `[mcp_servers.agentmemory]` entry — i.e. a one-field test would be
    // green exactly on the defect it is supposed to catch. The live proof of
    // that is the three-state block at the bottom of this file (И-3.6).
    expect(typeof entry?.command).toBe("string");
    expect((entry?.command as string).length).toBeGreaterThan(0);
  });

  it("does not blank the whole mcp_servers table (--config merges, it does not replace)", async () => {
    const provider = newProvider();
    await provider.compress("sys", "user");

    const servers = state.codexOptions[0].config?.mcp_servers ?? {};
    expect(Object.keys(servers)).toEqual(["agentmemory"]);
  });

  // ---- layer B -----------------------------------------------------------
  it("pins approvalPolicy to never on every thread (И-3.1, name-independent half)", async () => {
    const provider = newProvider();
    await provider.summarize("sys", "a");
    await provider.summarize("sys", "b");

    expect(state.threadOptions.length).toBe(2);
    for (const options of state.threadOptions) {
      expect(options.approvalPolicy).toBe("never");
    }
  });

  // ---- layer C -----------------------------------------------------------
  it("hands AGENTMEMORY_SDK_CHILD=1 to the child explicitly (И-3.2)", async () => {
    const provider = newProvider();
    let markerDuringCall: string | undefined;

    state.onRun = () => {
      markerDuringCall = state.codexOptions[0].env?.AGENTMEMORY_SDK_CHILD;
      return "<result>ok</result>";
    };

    await provider.compress("sys", "user");

    // Distinguishing: if the marker were left to `process.env` inheritance
    // instead of being passed, this field would be `undefined` while the call
    // itself still passed — the SDK does not inherit `process.env` at all once
    // `env` is supplied. "The call worked" separates nothing here.
    expect(markerDuringCall).toBe("1");
    expect(state.codexOptions[0].env?.AGENTMEMORY_SDK_CHILD).toBe("1");
  });

  it("sets the marker on process.env during the call and drops it after (И-3.2)", async () => {
    const provider = newProvider();
    let markerDuringCall: string | undefined;

    state.onRun = () => {
      markerDuringCall = process.env.AGENTMEMORY_SDK_CHILD;
      return "<result>ok</result>";
    };

    expect(process.env.AGENTMEMORY_SDK_CHILD).toBeUndefined();
    await provider.compress("sys", "user");

    expect(markerDuringCall).toBe("1");
    expect(process.env.AGENTMEMORY_SDK_CHILD).toBeUndefined();
  });

  it("restores a pre-existing marker value instead of deleting it (И-3.3)", async () => {
    const provider = newProvider();
    process.env.AGENTMEMORY_SDK_CHILD = "prev-value";

    await provider.summarize("sys", "user");

    expect(process.env.AGENTMEMORY_SDK_CHILD).toBe("prev-value");
  });

  it("keeps the marker set for the full overlap of concurrent calls (И-3.3)", async () => {
    const provider = newProvider();
    const observations: Array<{ phase: string; marker: string | undefined }> = [];

    state.onRun = async (input) => {
      observations.push({ phase: `${input}:enter`, marker: process.env.AGENTMEMORY_SDK_CHILD });
      await new Promise((resolve) => setTimeout(resolve, 5));
      observations.push({ phase: `${input}:exit`, marker: process.env.AGENTMEMORY_SDK_CHILD });
      return `<result>${input}</result>`;
    };

    await Promise.all([
      provider.summarize("sys", "x"),
      provider.summarize("sys", "y"),
      provider.summarize("sys", "z"),
    ]);

    // Distinguishing: with a per-call snapshot instead of a refcount, the
    // first call to finish restores the marker while its siblings are still in
    // flight, so at least one ":exit" observation would be `undefined`.
    expect(observations.length).toBe(6);
    for (const observation of observations) {
      expect(observation.marker).toBe("1");
    }
    expect(process.env.AGENTMEMORY_SDK_CHILD).toBeUndefined();
  });

  // ---- И-3.5 -------------------------------------------------------------
  it("does not rely on a truncated child PATH (И-3.5)", async () => {
    const provider = newProvider();
    await provider.compress("sys", "user");

    // The child gets the real PATH, so the absence of MCP traffic cannot be an
    // artefact of the server's launcher being unreachable — that confound was
    // measured and rejected in the plan. Layers A and B carry the guarantee.
    expect(state.codexOptions[0].env?.PATH).toBe(process.env.PATH);
  });

  // ---- layer D -----------------------------------------------------------
  it("concurrent calls all reach the SDK, none degrades to empty (#781)", async () => {
    const provider = newProvider();

    const results = await Promise.all([
      provider.summarize("sys", "chunk 1"),
      provider.summarize("sys", "chunk 2"),
      provider.summarize("sys", "chunk 3"),
      provider.summarize("sys", "chunk 4"),
    ]);

    expect(results).toEqual([
      "<result>ok</result>",
      "<result>ok</result>",
      "<result>ok</result>",
      "<result>ok</result>",
    ]);
    expect(state.runInputs.length).toBe(4);
    expect(state.threadOptions.length).toBe(4);
  });

  it("re-entry inside the same async tree returns empty and starts no second thread (И-3.4)", async () => {
    const provider = newProvider();
    let innerResult = "not-set";

    state.onRun = async () => {
      innerResult = await provider.compress("sys-inner", "user-inner");
      return "<result>outer</result>";
    };

    const outer = await provider.compress("sys", "user");

    expect(outer).toBe("<result>outer</result>");
    expect(innerResult).toBe("");
    // Distinguishing: without the ALS frame the inner call would spawn its own
    // turn, so both counters would read 2.
    expect(state.threadOptions.length).toBe(1);
    expect(state.runInputs.length).toBe(1);
  });

  it("re-entry does not disturb the marker of the outer call (И-3.3 + И-3.4)", async () => {
    const provider = newProvider();
    let markerAfterInner: string | undefined;

    state.onRun = async () => {
      await provider.summarize("sys-inner", "user-inner");
      markerAfterInner = process.env.AGENTMEMORY_SDK_CHILD;
      return "<result>outer</result>";
    };

    await provider.summarize("sys", "user");

    expect(markerAfterInner).toBe("1");
    expect(process.env.AGENTMEMORY_SDK_CHILD).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 3, И-3.6 — the override must not break CONFIG LOADING, in any state a
// user's machine can be in.
//
// This block runs the REAL Codex binary (`codex mcp list`, no network, no LLM)
// against three synthetic HOMEs. Everything above this line mocks the SDK, and
// a mock cannot answer this question at all: the failure lives in the Rust
// CLI's config parser, not in our object graph.
//
// Why it cannot be folded into И-3.1 ("no mcp_tool_call in the turn"): a
// provider whose child exits 1 before the network produces no turn, hence no
// `mcp_tool_call` — И-3.1 passes on a completely dead provider. "The channel is
// closed" and "the process never started" are separated by this block only.
// ---------------------------------------------------------------------------

const CODEX_PLATFORM_PACKAGE_BY_TARGET: Record<string, string> = {
  "x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
  "aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",
  "x86_64-apple-darwin": "@openai/codex-darwin-x64",
  "aarch64-apple-darwin": "@openai/codex-darwin-arm64",
  "x86_64-pc-windows-msvc": "@openai/codex-win32-x64",
  "aarch64-pc-windows-msvc": "@openai/codex-win32-arm64",
};

/** Same triple derivation as `findCodexPath()`
 * (`@openai/codex-sdk/dist/index.js:382-424`). */
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

/**
 * Resolves the vendored binary the SDK itself would spawn. It THROWS when the
 * triple is supported but the blob is absent, and that is deliberate: a silent
 * skip there would report "green" on the very machine where the provider is
 * broken (the D-18 shape). The block is skipped only where Codex has no build
 * at all, i.e. where the provider cannot exist in the first place.
 */
function codexBinaryPath(): string {
  const triple = codexTargetTriple();
  if (!triple) throw new Error(`unsupported platform: ${process.platform}/${process.arch}`);
  const platformPackage = CODEX_PLATFORM_PACKAGE_BY_TARGET[triple];
  const rootRequire = createRequire(import.meta.url);
  const codexRequire = createRequire(rootRequire.resolve("@openai/codex/package.json"));
  const platformPackageJson = codexRequire.resolve(`${platformPackage}/package.json`);
  const binary = join(
    dirname(platformPackageJson),
    "vendor",
    triple,
    "bin",
    process.platform === "win32" ? "codex.exe" : "codex",
  );
  if (!existsSync(binary)) {
    throw new Error(`Codex binary missing at ${binary} (${platformPackage})`);
  }
  return binary;
}

/**
 * Mirrors `serializeConfigOverrides` + `toTomlValue`
 * (`@openai/codex-sdk/dist/index.js:306-345`): nested objects become dotted
 * paths, strings are JSON-quoted, booleans are bare. Duplicated rather than
 * imported because the SDK exports neither — and this is the point of the test:
 * the flags below are built from the object the PROVIDER really passed, not
 * from a literal retyped here.
 */
function flattenConfigOverrides(value: unknown, prefix: string, out: string[]): void {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      flattenConfigOverrides(child, prefix ? `${prefix}.${key}` : key, out);
    }
    return;
  }
  out.push(`${prefix}=${typeof value === "string" ? JSON.stringify(value) : String(value)}`);
}

/** The `--config` flags the provider's own override turns into. */
async function overrideFlagsOfProvider(): Promise<string[]> {
  resetState();
  await newProvider().compress("sys", "user");
  const flags: string[] = [];
  flattenConfigOverrides(state.codexOptions[0].config, "", flags);
  return flags;
}

function homeWith(configToml: string | null): string {
  const home = mkdtempSync(join(dataDir, "codex-home-"));
  if (configToml !== null) {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), configToml, "utf8");
  }
  return home;
}

/** `env -i` in spawn form: the child gets a PATH and a HOME and nothing else,
 * so the outcome cannot ride on this process's own Codex environment. */
function runMcpList(home: string, flags: string[]) {
  const result = spawnSync(
    codexBinaryPath(),
    ["mcp", "list", ...flags.flatMap((flag) => ["-c", flag])],
    { env: { PATH: "/usr/bin:/bin", HOME: home }, encoding: "utf8", timeout: 60_000 },
  );
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

const FOREIGN_SERVER_TOML = '[mcp_servers.other]\ncommand = "echo"\nargs = ["hi"]\n';
const AGENTMEMORY_SERVER_TOML =
  '[mcp_servers.agentmemory]\ncommand = "npx"\nargs = ["-y", "@agentmemory/mcp"]\n';

describe.skipIf(codexTargetTriple() === undefined)(
  "CodexProvider MCP override against the real Codex config loader (И-3.6)",
  () => {
    // The three states a user's machine can be in. The middle one is the
    // boundary of the defect: a config file EXISTS, it just has no agentmemory
    // entry — "no config file" is not the condition.
    const states = [
      { name: "no ~/.codex/config.toml at all", toml: null, neighbour: false },
      { name: "config with a foreign server only", toml: FOREIGN_SERVER_TOML, neighbour: true },
      {
        name: "config with the agentmemory entry (the state every earlier measurement was taken in)",
        toml: `${AGENTMEMORY_SERVER_TOML}${FOREIGN_SERVER_TOML}`,
        neighbour: true,
      },
    ];

    for (const machineState of states) {
      it(`loads the config and disables agentmemory — ${machineState.name}`, async () => {
        const flags = await overrideFlagsOfProvider();
        const home = homeWith(machineState.toml);

        const { status, output } = runMcpList(home, flags);

        expect({ status, output }).toEqual({ status: 0, output: expect.any(String) });
        // `disabled` contains no word-boundary match for `enabled`, so these two
        // patterns cannot both fire on the same row.
        expect(output).toMatch(/^agentmemory\s+.*\bdisabled\b/m);
        if (machineState.neighbour) {
          // Positive control: the override changes one row, not the table.
          expect(output).toMatch(/^other\s+.*\benabled\b/m);
        }
      }, 60_000);

      it(`negative control: the transport-less override breaks it — ${machineState.name}`, async () => {
        const flags = (await overrideFlagsOfProvider()).filter(
          (flag) => !flag.startsWith("mcp_servers.agentmemory.command="),
        );
        expect(flags).toEqual(["mcp_servers.agentmemory.enabled=false"]);
        const home = homeWith(machineState.toml);

        const { status, output } = runMcpList(home, flags);

        if (machineState.toml?.includes("[mcp_servers.agentmemory]")) {
          // Where the entry already exists the merge has a transport to keep,
          // so the broken form works — which is precisely why measuring only
          // this state hid the defect.
          expect(status).toBe(0);
          expect(output).toMatch(/^agentmemory\s+.*\bdisabled\b/m);
        } else {
          // Distinguishing: this is the state the fixed override has to
          // survive. If this assertion ever stops holding, the stub is no
          // longer load-bearing and the test above stopped measuring anything.
          expect(status).not.toBe(0);
          expect(output).toContain("invalid transport");
        }
      }, 60_000);
    }
  },
);

// ---------------------------------------------------------------------------
// Phase 4 — child process lifecycle
// ---------------------------------------------------------------------------

/** A pid that is provably NOT running, so the sweeper's liveness branch can be
 * exercised without inventing a process to kill. */
function findDeadPid(): number {
  for (let pid = 99_000; pid > 40_000; pid--) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return pid;
    }
  }
  throw new Error("no dead pid could be found on this machine");
}

describe("CodexProvider child process lifecycle", () => {
  beforeEach(() => {
    resetState();
    delete process.env.AGENTMEMORY_SDK_CHILD;
    delete process.env[TIMEOUT_ENV];
    delete process.env[CONCURRENCY_ENV];
  });

  afterEach(() => {
    delete process.env.AGENTMEMORY_SDK_CHILD;
    delete process.env[TIMEOUT_ENV];
    delete process.env[CONCURRENCY_ENV];
  });

  // ---- timeout (И-4.1, И-4.5) --------------------------------------------
  it("passes a signal to every turn and rejects with codex_timeout when it fires (И-4.1)", async () => {
    process.env[TIMEOUT_ENV] = "40";
    state.onRun = hangUntilAborted;
    const provider = newProvider();

    // Distinguishing: without `TurnOptions.signal` the mocked turn never
    // settles, so the failure would be vitest's own 5 s test timeout — a
    // different line in the report, and NOT this assertion passing.
    await expect(provider.compress("sys", "user")).rejects.toThrow(
      "codex_timeout",
    );
    expect(state.turnOptions.length).toBe(1);
    expect(signalOf(0)?.aborted).toBe(true);
  });

  it("times out one call without touching a sibling's signal (И-4.5)", async () => {
    process.env[CONCURRENCY_ENV] = "2";
    process.env[TIMEOUT_ENV] = "60";
    state.onRun = (input, turnOptions) =>
      input.includes("slow")
        ? hangUntilAborted(input, turnOptions)
        : Promise.resolve("<result>fast</result>");
    const provider = newProvider();

    const results = await Promise.allSettled([
      provider.summarize("sys", "fast"),
      provider.summarize("sys", "slow"),
    ]);

    const slowIndex = state.runInputs.findIndex((input) =>
      input.includes("slow"),
    );
    const fastIndex = state.runInputs.findIndex((input) =>
      input.includes("fast"),
    );

    expect(results[0]).toMatchObject({
      status: "fulfilled",
      value: "<result>fast</result>",
    });
    expect(results[1].status).toBe("rejected");
    expect((results[1] as PromiseRejectedResult).reason.message).toBe(
      "codex_timeout",
    );
    // Distinguishing: with one controller shared by the provider, the slow
    // call's timeout would have aborted the fast call's signal too.
    expect(signalOf(slowIndex)?.aborted).toBe(true);
    expect(signalOf(fastIndex)?.aborted).toBe(false);
  });

  it("passes a non-timeout turn failure through unchanged", async () => {
    state.onRun = () => Promise.reject(new Error("turn exploded"));
    const provider = newProvider();

    // The phase introduces exactly one new error identifier. A turn that fails
    // for its own reasons must not be relabelled `codex_timeout`.
    await expect(provider.compress("sys", "user")).rejects.toThrow(
      "turn exploded",
    );
  });

  // ---- in-flight bookkeeping (И-4.2) --------------------------------------
  it("empties the in-flight set on success and on failure alike (И-4.2)", async () => {
    process.env[CONCURRENCY_ENV] = "4";
    let peakInFlight = 0;
    state.onRun = async (input) => {
      peakInFlight = Math.max(peakInFlight, codexInFlightCount());
      await sleep(5);
      if (input.includes("boom")) throw new Error("turn exploded");
      return "<result>ok</result>";
    };
    const provider = newProvider();

    await Promise.allSettled([
      provider.compress("sys", "a"),
      provider.compress("sys", "boom"),
      provider.summarize("sys", "c"),
    ]);

    // Positive control: "0 afterwards" would also hold if the set were never
    // populated at all, i.e. if the shutdown handler had nothing to abort.
    expect(peakInFlight).toBe(3);
    expect(codexInFlightCount()).toBe(0);
  });

  // ---- shutdown (И-4.3) ---------------------------------------------------
  it("adds a SIGTERM listener without displacing existing ones (И-4.3)", async () => {
    process.env[CONCURRENCY_ENV] = "3";
    const sentinel = vi.fn();
    process.on("SIGTERM", sentinel);

    try {
      const provider = newProvider();
      newProvider();
      newProvider();

      expect(process.listeners("SIGTERM")).toContain(abortInFlightCodexTurns);
      expect(process.listeners("beforeExit")).toContain(
        abortInFlightCodexTurns,
      );
      // Additive: the pre-existing listener is still there, and building three
      // providers registers ours exactly once (no listener leak).
      expect(process.listeners("SIGTERM")).toContain(sentinel);
      expect(
        process
          .listeners("SIGTERM")
          .filter((listener) => listener === abortInFlightCodexTurns).length,
      ).toBe(1);

      state.onRun = hangUntilAborted;
      const calls = Promise.allSettled([
        provider.compress("sys", "a"),
        provider.compress("sys", "b"),
        provider.compress("sys", "c"),
      ]);
      await waitFor(() => state.turnOptions.length === 3, "three turns started");

      process.emit("SIGTERM" as NodeJS.Signals);

      // Distinguishing: with no handler installed these stay `aborted === false`
      // and the calls never settle — that is precisely "the child survives a
      // clean stop and is left to be SIGKILLed with the parent".
      for (let index = 0; index < 3; index++) {
        expect(signalOf(index)?.aborted).toBe(true);
      }
      const results = await calls;
      for (const result of results) {
        expect(result.status).toBe("rejected");
      }
      expect(sentinel).toHaveBeenCalledTimes(1);
      expect(codexInFlightCount()).toBe(0);
    } finally {
      process.off("SIGTERM", sentinel);
    }
  });

  // ---- concurrency cap (И-4.4) -------------------------------------------
  it("runs at most MAX_CONCURRENCY turns at once and drops no waiter (И-4.4)", async () => {
    process.env[CONCURRENCY_ENV] = "1";
    state.onRun = async (input) => {
      await sleep(5);
      return `<result>${input}</result>`;
    };
    const provider = newProvider();

    const results = await Promise.all([
      provider.summarize("sys", "one"),
      provider.summarize("sys", "two"),
      provider.summarize("sys", "three"),
    ]);

    // All three reached the SDK and all three got their OWN answer: the cap is
    // a queue, not a rejection.
    expect(state.runInputs.length).toBe(3);
    expect(results).toEqual([
      "<result>sys\n\none</result>",
      "<result>sys\n\ntwo</result>",
      "<result>sys\n\nthree</result>",
    ]);
    expect(state.peakActiveRuns).toBe(1);
  });

  it("positive control: raising the cap really does overlap turns", async () => {
    process.env[CONCURRENCY_ENV] = "3";
    state.onRun = async () => {
      await sleep(10);
      return "<result>ok</result>";
    };
    const provider = newProvider();

    await Promise.all([
      provider.summarize("sys", "one"),
      provider.summarize("sys", "two"),
      provider.summarize("sys", "three"),
    ]);

    // Without this control, "peak === 1" above would also pass if the peak
    // counter simply never rose — i.e. if the test measured nothing.
    expect(state.peakActiveRuns).toBe(3);
  });

  // ---- working directory (И-2.3, И-4.7) ----------------------------------
  it("puts the working directory under <dataDir>/tmp/codex/<parent pid>/", async () => {
    const provider = newProvider();
    let observed = "";
    state.onRun = (_input, _turnOptions) => {
      observed = workingDirectoryOf(0);
      return "<result>ok</result>";
    };

    await provider.compress("sys", "user");

    // Distinguishing: an anonymous `mkdtemp` in the system $TMPDIR would still
    // give the turn a valid empty directory, and every other assertion in this
    // file would pass — while the external sweeper would lose its only
    // ownership marker, because the path would no longer name the parent.
    expect(observed.startsWith(join(dataDir, "tmp", "codex", String(process.pid)) + "/")).toBe(
      true,
    );
  });

  it("removes the working directory after a successful turn (И-4.7)", async () => {
    const provider = newProvider();
    let existedDuringTurn = false;
    state.onRun = () => {
      existedDuringTurn = existsSync(workingDirectoryOf(0));
      return "<result>ok</result>";
    };

    await provider.compress("sys", "user");

    expect(existedDuringTurn).toBe(true);
    expect(existsSync(workingDirectoryOf(0))).toBe(false);
  });

  it("removes the working directory after a thrown turn (И-4.7)", async () => {
    const provider = newProvider();
    state.onRun = () => Promise.reject(new Error("turn exploded"));

    await expect(provider.compress("sys", "user")).rejects.toThrow(
      "turn exploded",
    );

    // Distinguishing: cleanup written only in the success branch passes the
    // test above and leaks on this path and the next one. In `npm test` the
    // leak shows up nowhere at all; on the live daemon it shows up only
    // indirectly, as a sweeper that keeps finding non-empty trees.
    expect(existsSync(workingDirectoryOf(0))).toBe(false);
  });

  it("removes the working directory after an aborted turn (И-4.7)", async () => {
    process.env[TIMEOUT_ENV] = "30";
    const provider = newProvider();
    state.onRun = hangUntilAborted;

    await expect(provider.compress("sys", "user")).rejects.toThrow(
      "codex_timeout",
    );

    expect(existsSync(workingDirectoryOf(0))).toBe(false);
  });

  // ---- startup sweeper (И-4.6) -------------------------------------------
  it("sweeps the tree of a dead parent and leaves live parents alone (И-4.6)", async () => {
    const root = join(dataDir, "tmp", "codex");
    const deadPid = findDeadPid();
    const deadTree = join(root, String(deadPid));
    const ownTree = join(root, String(process.pid));
    const otherLiveTree = join(root, String(process.ppid));
    mkdirSync(join(deadTree, "call-dead"), { recursive: true });
    mkdirSync(join(ownTree, "call-own"), { recursive: true });
    mkdirSync(join(otherLiveTree, "call-other"), { recursive: true });

    try {
      await sweepOrphanedCodexRuns();

      expect(existsSync(deadTree)).toBe(false);
      // Distinguishing, and the half that actually matters: a sweeper without
      // the liveness check deletes both, and "the dead one is gone" would pass
      // under either behaviour. `process.ppid` is a live parent that is NOT
      // this process, so it also proves the survival is the liveness check and
      // not the self-pid shortcut.
      expect(existsSync(ownTree)).toBe(true);
      expect(existsSync(otherLiveTree)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves directories that carry no parent pid in their name", async () => {
    const root = join(dataDir, "tmp", "codex");
    const unnamed = join(root, "call-legacy");
    mkdirSync(unnamed, { recursive: true });

    try {
      await sweepOrphanedCodexRuns();
      // Such a directory cannot be proven dead — it names no parent. Deleting
      // it would be exactly the mistake the liveness check exists to prevent,
      // one level up.
      expect(existsSync(unnamed)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 5 — authorization and installation as a user-visible process
// ---------------------------------------------------------------------------

type CodexModule = typeof import("../src/providers/codex.js");
type LoggerModule = typeof import("../src/logger.js");

const loadedModules: CodexModule[] = [];

/**
 * "Once per process" is a module-scoped flag, so every test that measures it
 * needs a virgin module — otherwise the first test to trigger a warning burns
 * the flag for all the others and they measure nothing. `vi.resetModules()`
 * plus a dynamic import is the closest thing to a fresh process inside one
 * vitest run; `vi.mock` above stays in force for the re-imported graph.
 */
async function freshCodexModule(): Promise<{
  codexModule: CodexModule;
  loggerModule: LoggerModule;
}> {
  vi.resetModules();
  const codexModule = await import("../src/providers/codex.js");
  // Imported AFTER codex.js so it resolves to the same fresh instance codex.js
  // is writing through — a logger from the previous graph would answer about
  // another module's state.
  const loggerModule = await import("../src/logger.js");
  loadedModules.push(codexModule);
  return { codexModule, loggerModule };
}

function providerFrom(codexModule: CodexModule) {
  return new codexModule.CodexProvider({
    provider: "codex",
    model: CODEX_DEFAULT_MODEL,
    maxTokens: 1024,
  });
}

/**
 * Captures what actually reaches stderr, rather than asserting that some log
 * function was called. The invariant of this phase is about the CHANNEL: a
 * message sent through `bootLog` is buffered and dropped in quiet mode
 * (`src/logger.ts:88-98`), and a test that only checked "a logger was invoked"
 * would pass on exactly that broken variant.
 */
function captureStderr() {
  const lines: string[] = [];
  const spy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    }) as unknown as typeof process.stderr.write);
  return {
    lines,
    text: () => lines.join(""),
    restore: () => spy.mockRestore(),
  };
}

/** The live 401 as research §2 measured it, verbatim including the parts that
 * must NOT end up in our log. */
function unauthorizedError(): Error {
  return new Error(
    "unexpected status 401 Unauthorized: Missing bearer or basic authentication " +
      "in header, url: https://api.openai.com/v1/responses, " +
      "cf-ray: 9a1b2c3d4e5f6789-FRA, request id: req_0123456789abcdef",
  );
}

/** `dist/index.js:440` — the D-18 case: the vendor tree of the wrong
 * architecture. It names neither the module nor the architecture, which is why
 * the classifier cannot be textual. */
function badInstallError(): Error {
  return new Error(
    "Unable to locate Codex CLI binaries. Ensure @openai/codex is installed " +
      "with optional dependencies.",
  );
}

/** Computed here the same way the provider computes it, from
 * `PLATFORM_PACKAGE_BY_TARGET` (`dist/index.js:147-154`). Not read back from
 * the provider: a test that asked the code under test for the expected value
 * would agree with any answer it gave. */
function expectedPlatformPackage(): string | undefined {
  const platform =
    process.platform === "android"
      ? "linux"
      : process.platform === "darwin" ||
          process.platform === "linux" ||
          process.platform === "win32"
        ? process.platform
        : undefined;
  if (!platform) return undefined;
  if (process.arch !== "x64" && process.arch !== "arm64") return undefined;
  return `@openai/codex-${platform}-${process.arch}`;
}

const AUTH_MARK = "no ChatGPT/Codex session";
const INSTALL_MARK = "platform package missing";

function linesWith(lines: string[], mark: string): string[] {
  return lines.filter((line) => line.includes(mark));
}

describe("CodexProvider authorization and installation diagnosis", () => {
  let previousVerbose: string | undefined;

  beforeAll(() => {
    // Pin quiet mode: `bootVerbose` is read from the environment when the
    // logger module loads, and every test here loads a fresh one. Verbose mode
    // would make `bootLog` write to stderr too and destroy the control below.
    previousVerbose = process.env.AGENTMEMORY_VERBOSE;
    delete process.env.AGENTMEMORY_VERBOSE;
  });

  afterAll(() => {
    if (previousVerbose !== undefined) {
      process.env.AGENTMEMORY_VERBOSE = previousVerbose;
    }
  });

  beforeEach(() => {
    resetState();
    delete process.env.AGENTMEMORY_SDK_CHILD;
    delete process.env[TIMEOUT_ENV];
    delete process.env[CONCURRENCY_ENV];
  });

  afterEach(() => {
    // Each freshly imported module registers its own shutdown listeners.
    for (const codexModule of loadedModules.splice(0)) {
      process.off("SIGTERM", codexModule.abortInFlightCodexTurns);
      process.off("beforeExit", codexModule.abortInFlightCodexTurns);
    }
    delete process.env.AGENTMEMORY_SDK_CHILD;
    delete process.env[TIMEOUT_ENV];
    delete process.env[CONCURRENCY_ENV];
  });

  it("warns exactly once on a 401 turn and still throws (И-5.4)", async () => {
    const { codexModule } = await freshCodexModule();
    state.onRun = () => Promise.reject(unauthorizedError());
    const provider = providerFrom(codexModule);

    const capture = captureStderr();
    try {
      // Distinguishing: returning "" here would look like an empty successful
      // answer, sail past the circuit breaker and leave the user waiting
      // instead of getting the 30-second pause.
      await expect(provider.compress("sys", "user")).rejects.toThrow(
        "codex_unauthorized",
      );
    } finally {
      capture.restore();
    }

    const warnings = linesWith(capture.lines, AUTH_MARK);
    expect(warnings.length).toBe(1);
    expect(warnings[0].startsWith("[agentmemory] warn ")).toBe(true);
    // Names the symptom and the action.
    expect(warnings[0]).toContain("401");
    expect(warnings[0]).toContain("api.openai.com");
    expect(warnings[0]).toContain("Codex CLI");
    // Carries none of the upstream response, and never points at the
    // credential file (И-5.1, handoff §8.7).
    expect(capture.text()).not.toContain("cf-ray");
    expect(capture.text()).not.toContain("request id");
    expect(capture.text()).not.toContain("auth.json");
  });

  it("stays silent on a failure that is not a 401", async () => {
    const { codexModule } = await freshCodexModule();
    state.onRun = () => Promise.reject(new Error("model refused"));
    const provider = providerFrom(codexModule);

    const capture = captureStderr();
    try {
      await expect(provider.compress("sys", "user")).rejects.toThrow(
        "model refused",
      );
    } finally {
      capture.restore();
    }

    // The other half of the test above: without it, an implementation that
    // warned on EVERY failure would pass "warned once on a 401" unchanged.
    expect(linesWith(capture.lines, AUTH_MARK).length).toBe(0);
    expect(linesWith(capture.lines, INSTALL_MARK).length).toBe(0);
  });

  it("warns once, not twice, across two consecutive 401 calls (И-5.5)", async () => {
    const { codexModule } = await freshCodexModule();
    state.onRun = () => Promise.reject(unauthorizedError());
    const provider = providerFrom(codexModule);

    const capture = captureStderr();
    try {
      await expect(provider.compress("sys", "one")).rejects.toThrow(
        "codex_unauthorized",
      );
      await expect(provider.compress("sys", "two")).rejects.toThrow(
        "codex_unauthorized",
      );
    } finally {
      capture.restore();
    }

    // `compressWithRetry` makes a second call on its own, and `compress` runs
    // on every observation — a per-failure warning floods the daemon log.
    expect(state.runInputs.length).toBe(2);
    expect(linesWith(capture.lines, AUTH_MARK).length).toBe(1);
  });

  it("keeps the two once-flags independent: a bad install does not mute the 401 (И-5.5)", async () => {
    const { codexModule } = await freshCodexModule();

    const capture = captureStderr();
    try {
      state.constructorError = badInstallError();
      const broken = providerFrom(codexModule);
      await expect(broken.compress("sys", "user")).rejects.toThrow(
        "codex_bad_install",
      );

      state.constructorError = null;
      state.onRun = () => Promise.reject(unauthorizedError());
      const other = providerFrom(codexModule);
      await expect(other.compress("sys", "user")).rejects.toThrow(
        "codex_unauthorized",
      );
    } finally {
      capture.restore();
    }

    // Distinguishing: ONE shared flag passes the "same condition twice" test
    // above in full and silently swallows the second diagnosis. Only a pair of
    // DIFFERENT conditions in a row can tell the two implementations apart.
    expect(linesWith(capture.lines, INSTALL_MARK).length).toBe(1);
    expect(linesWith(capture.lines, AUTH_MARK).length).toBe(1);
    // The failed constructor path must not leak a controller either.
    expect(codexModule.codexInFlightCount()).toBe(0);
  });

  it("produces three DIFFERENT outcomes for timeout, bad install and 401 (И-5.6)", async () => {
    const messages: string[] = [];

    {
      const { codexModule } = await freshCodexModule();
      process.env[TIMEOUT_ENV] = "40";
      state.onRun = hangUntilAborted;
      const provider = providerFrom(codexModule);
      const capture = captureStderr();
      try {
        await provider.compress("sys", "user");
      } catch (error) {
        messages.push((error as Error).message);
      } finally {
        capture.restore();
      }
      // A timeout is not a diagnosis this phase speaks about.
      expect(linesWith(capture.lines, AUTH_MARK).length).toBe(0);
      expect(linesWith(capture.lines, INSTALL_MARK).length).toBe(0);
      delete process.env[TIMEOUT_ENV];
    }

    {
      resetState();
      const { codexModule } = await freshCodexModule();
      state.constructorError = badInstallError();
      const provider = providerFrom(codexModule);
      const capture = captureStderr();
      try {
        await provider.compress("sys", "user");
      } catch (error) {
        messages.push((error as Error).message);
      } finally {
        capture.restore();
      }
    }

    {
      resetState();
      const { codexModule } = await freshCodexModule();
      state.onRun = () => Promise.reject(unauthorizedError());
      const provider = providerFrom(codexModule);
      const capture = captureStderr();
      try {
        await provider.compress("sys", "user");
      } catch (error) {
        messages.push((error as Error).message);
      } finally {
        capture.restore();
      }
    }

    // Distinguishing: one shared message would make all three inputs produce
    // one output, and a check of the shape "the error was handled" would pass
    // over a completely collapsed classifier. What is measured is that the
    // outputs are THREE DIFFERENT ones — this being the last place upstack
    // where they are distinguishable at all (`fallback-chain.ts:18-30`).
    expect(messages.length).toBe(3);
    expect(new Set(messages).size).toBe(3);
    expect(messages[0]).toBe("codex_timeout");
    expect(messages[1]).toContain("codex_bad_install");
    expect(messages[2]).toContain("codex_unauthorized");

    // The architecture, computed by us: the upstream text of `:440` carries
    // neither the module name nor the arch, so a test asserting it came from
    // the error would be asserting a string that does not exist in the pin.
    const platformPackage = expectedPlatformPackage();
    if (platformPackage) {
      expect(messages[1]).toContain(platformPackage);
      expect(messages[1]).not.toContain("Sign in");
    }
  });

  it("classifies by POSITION: the same 401 text from getCodex() is a bad install", async () => {
    const fromConstructor = await (async () => {
      const { codexModule } = await freshCodexModule();
      state.constructorError = new Error(
        "boom: unexpected status 401 Unauthorized while resolving the CLI",
      );
      const provider = providerFrom(codexModule);
      const capture = captureStderr();
      try {
        return await provider
          .compress("sys", "user")
          .then(() => "resolved")
          .catch((error: Error) => error.message);
      } finally {
        capture.restore();
      }
    })();

    resetState();

    const fromRun = await (async () => {
      const { codexModule } = await freshCodexModule();
      state.onRun = () =>
        Promise.reject(
          new Error(
            "boom: unexpected status 401 Unauthorized while resolving the CLI",
          ),
        );
      const provider = providerFrom(codexModule);
      const capture = captureStderr();
      try {
        return await provider
          .compress("sys", "user")
          .then(() => "resolved")
          .catch((error: Error) => error.message);
      } finally {
        capture.restore();
      }
    })();

    // Distinguishing: with a textual classifier, or with the two branches in
    // the opposite order, IDENTICAL text would give the same verdict on both
    // paths — i.e. "fix your login" advice to a user whose installation is
    // broken (the D-31 class). Same text, two positions, two verdicts.
    expect(fromConstructor).toContain("codex_bad_install");
    expect(fromRun).toContain("codex_unauthorized");
  });

  it("sends the warning through a channel that survives quiet mode (И-5.3)", async () => {
    const { codexModule, loggerModule } = await freshCodexModule();
    expect(loggerModule.isBootVerbose()).toBe(false);
    state.onRun = () => Promise.reject(unauthorizedError());
    const provider = providerFrom(codexModule);

    const capture = captureStderr();
    try {
      loggerModule.bootLog("control-line-that-must-not-surface");
      await expect(provider.compress("sys", "user")).rejects.toThrow(
        "codex_unauthorized",
      );
    } finally {
      capture.restore();
    }

    // The control is the point: in quiet mode `bootLog` writes nothing at all,
    // so a warning sent through it would be invisible on the live daemon while
    // every "the logger was called" assertion still passed.
    expect(capture.text()).not.toContain("control-line-that-must-not-surface");
    expect(linesWith(capture.lines, AUTH_MARK).length).toBe(1);
  });
});
