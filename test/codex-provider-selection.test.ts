import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, afterAll, beforeEach, afterEach, vi } from "vitest";

// Wave 4, phase 7 — the three channels through which a "successful" answer can
// come from something other than Codex-on-a-subscription:
//
//   1  a Codex session that already exists on the machine (isolated by HOME)
//   2  agent-sdk (Claude) answering from the factory's `default` branch
//   3  a DeepSeek key wearing the OpenAI-family variable names
//
// Every check here is written against what the provider HANDS TO THE SDK, never
// against the fact that a call returned text: all three channels return
// well-formed, plausible text, so "the provider answered" has the same value
// with the defect and without it (rule 16). Each channel is therefore a PAIR —
// the state of affairs and its opposite (И-7.3).
//
// No live call is made from this file (И-7.1): the SDK is mocked, so nothing
// spends the operator's subscription and nothing depends on the network. The
// live half of channel 1 (isolated HOME -> 401 in 28 267 ms vs live HOME ->
// answer in 8 556-10 055 ms) lives in test/codex-provider-live.test.ts, which
// vitest.config.ts excludes unless AGENTMEMORY_CODEX_LIVE=1.
const state = vi.hoisted(() => ({
  // Counts EVALUATIONS of the `@openai/codex-sdk` module, not calls into it.
  // The lazy-import invariant (И-2.2) is about module resolution, and a counter
  // of constructor calls could not tell "resolved but unused" from "not
  // resolved".
  sdkModuleLoads: 0,
  codexOptions: [] as Array<Record<string, any>>,
  threadOptions: [] as Array<Record<string, any>>,
  // A snapshot of this process's own environment taken DURING the turn. Used to
  // prove the parent really held the secret at the moment of the call — without
  // it, "the child's env has no key" would also pass when the test simply
  // forgot to plant one.
  parentEnvDuringTurn: null as Record<string, string | undefined> | null,
}));

vi.mock("@openai/codex-sdk", () => {
  state.sdkModuleLoads++;
  return {
    Codex: class {
      constructor(options: Record<string, any>) {
        state.codexOptions.push(options);
      }
      startThread(options: Record<string, any>) {
        state.threadOptions.push(options);
        return {
          async run(_input: string, _turnOptions?: Record<string, any>) {
            state.parentEnvDuringTurn = { ...process.env };
            return { finalResponse: "<result>ok</result>" };
          },
        };
      }
    },
  };
});

import { CodexProvider } from "../src/providers/codex.js";
import { CODEX_DEFAULT_MODEL, createProvider } from "../src/providers/index.js";
import { loadConfig } from "../src/config.js";
import type { MemoryProvider, ProviderConfig } from "../src/types.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const fakeHome = resolve(rootDir, "test/fixtures/fake-home");

// Set at module scope, i.e. before any provider is built: every turn creates
// <dataDir>/tmp/codex/<pid>/call-* and the startup sweep walks that root. The
// developer's real data dir is not ours to walk.
const previousDataDir = process.env.AGENTMEMORY_DATA_DIR;
const dataDir = mkdtempSync(join(tmpdir(), "codex-selection-test-"));
process.env.AGENTMEMORY_DATA_DIR = dataDir;

// --- lazy-import probe, taken at module scope (И-2.2) ----------------------
//
// Both readings are taken here, under a top-level await, i.e. BEFORE any test
// body can run. That is not style: the counter below is monotonic and the
// mocked module is evaluated exactly once per file — `vi.resetModules()` does
// NOT re-arm it (measured: the factory is not re-run) — so a reading taken
// inside a test case would be reading whatever an earlier case already loaded,
// and would pass against an eager constructor.
const lazyProbeProvider = new CodexProvider({
  provider: "codex",
  model: CODEX_DEFAULT_MODEL,
  maxTokens: 1024,
});
// `import()` settles on a later tick, so a constructor that DID start one still
// reads as "nothing resolved" when measured synchronously. Drain timers, not
// just microtasks: that synchronous reading is what made the first version of
// this probe pass against an eager constructor.
await new Promise((done) => setTimeout(done, 0));
const sdkLoadsAfterConstruction = state.sdkModuleLoads;
const lazyProbeAnswer = await lazyProbeProvider.compress("sys", "user");
const sdkLoadsAfterFirstCall = state.sdkModuleLoads;

afterAll(() => {
  if (previousDataDir === undefined) {
    delete process.env.AGENTMEMORY_DATA_DIR;
  } else {
    process.env.AGENTMEMORY_DATA_DIR = previousDataDir;
  }
  rmSync(dataDir, { recursive: true, force: true });
});

// Every environment variable either provider-selection chain of src/config.ts
// reads, plus the ones this file plants. Cleared before each case: the suite
// runs on the pinned HOME of vitest.config.ts (test/fixtures/fake-home, which
// carries no .env), but a variable that is in the RUNNER's process.env still
// wins through getMergedEnv() and would send the channel-2 table into the
// `openai` branch as a whole. That mechanism produced the 11 baseline failures
// wave 2 fixed.
const MANAGED_ENVS = [
  "OPENAI_API_KEY",
  "OPENAI_API_KEY_FOR_LLM",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "MINIMAX_API_KEY",
  "MINIMAX_MODEL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_BASE_URL",
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
  "GOOGLE_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENROUTER_MODEL",
  "AGENTMEMORY_SUPPRESS_COST_WARNING",
  "AGENTMEMORY_ALLOW_AGENT_SDK",
  "AGENTMEMORY_CODEX",
  "AGENTMEMORY_CODEX_MODEL",
  "AGENTMEMORY_SDK_CHILD",
  "FALLBACK_PROVIDERS",
  "MAX_TOKENS",
  // Planted by the channel-1 case; a leftover would make a later case pass for
  // the wrong reason.
  "CODEX_SELECTION_TEST_SECRET",
] as const;

/** Anything shaped like a credential must not reach the child at all. A name
 * list would only catch the names we thought of; this catches the shape. */
const CREDENTIAL_SHAPED = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i;

function resetState(): void {
  state.codexOptions.length = 0;
  state.threadOptions.length = 0;
  state.parentEnvDuringTurn = null;
}

/** The `Codex` options of the single construction a case performed. */
function codexOptions(): Record<string, any> {
  expect(state.codexOptions.length, "exactly one Codex was constructed").toBe(1);
  return state.codexOptions[0];
}

function childEnvOf(): Record<string, string> {
  const env = codexOptions().env;
  // `undefined` is the shape that reopens channel 1: with no `env` the SDK
  // copies the whole `process.env` into the child (`dist/index.js:233-242`) and
  // the turn succeeds exactly as it does now.
  expect(env, "CodexOptions.env must be passed explicitly").toBeDefined();
  return env as Record<string, string>;
}

/**
 * The provider the factory really assembles, not the wrapper. `createProvider`
 * returns `ResilientProvider(createBaseProvider(config))` and
 * `createBaseProvider` is module-private, so its output is observed through the
 * wrapper's private `inner` — the same reach-in
 * test/config-provider-selection.test.ts uses.
 */
function baseOf(provider: MemoryProvider): MemoryProvider {
  return (provider as unknown as { inner: MemoryProvider }).inner;
}

/** Builds the provider the way the fallback chain does: by TYPE, without going
 * through detectProvider(). This is the reachable path on a machine whose
 * primary provider is keyed — exactly the machine channel 3 is about. */
function buildCodexByType(): MemoryProvider {
  const config: ProviderConfig = {
    provider: "codex",
    model: CODEX_DEFAULT_MODEL,
    maxTokens: 1024,
  };
  return createProvider(config);
}

describe("codex provider: the three false-success channels (wave 4, phase 7)", () => {
  const saved: Record<string, string | undefined> = {};
  const realStderrWrite = process.stderr.write.bind(process.stderr);

  beforeEach(() => {
    resetState();
    for (const key of MANAGED_ENVS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    // detectProvider() writes its zero-LLM advisory on the key-less rows of the
    // channel-2 table. Swallowed so the report stays readable; nothing here
    // asserts on it (test/config-provider-selection.test.ts does).
    process.stderr.write = (() => true) as unknown as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = realStderrWrite;
    for (const key of MANAGED_ENVS) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  });

  // ---- precondition of every table below (И-7.2) --------------------------
  it("runs on the pinned fake HOME, without which the tables measure nothing", () => {
    // Distinguishing: on the operator's real HOME `~/.agentmemory/.env` holds a
    // key, getMergedEnv() merges it, and the channel-2 table returns `openai`
    // on all four rows — four green-looking rows describing another provider.
    expect(process.env.HOME).toBe(fakeHome);
    expect(existsSync(join(fakeHome, ".agentmemory", ".env"))).toBe(false);
    // Positive control on the assertion itself: the path shape is right, so the
    // `false` above is "no file here", not "looked in a place that never has
    // one".
    expect(existsSync(join(fakeHome, ".agentmemory"))).toBe(true);
  });

  // ---- channel 1: a Codex session that already exists on this machine -----
  describe("channel 1 — the child's environment is ours, not the parent's", () => {
    it("passes CodexOptions.env explicitly and keeps the parent's secrets out of it", async () => {
      // Two plants: a real other-provider credential name (the daemon holds
      // these for every configured provider, src/config.ts:82 merges them in)
      // and a name nothing in the codebase knows about.
      process.env.ANTHROPIC_API_KEY = "sk-ant-planted-by-the-test";
      process.env.CODEX_SELECTION_TEST_SECRET = "planted-by-the-test";

      await buildCodexByType().compress("sys", "user");

      const env = childEnvOf();

      // The parent really held them at call time — otherwise the three
      // assertions below would pass against an empty premise.
      expect(state.parentEnvDuringTurn?.ANTHROPIC_API_KEY).toBe(
        "sk-ant-planted-by-the-test",
      );
      expect(state.parentEnvDuringTurn?.CODEX_SELECTION_TEST_SECRET).toBe(
        "planted-by-the-test",
      );

      expect(Object.hasOwn(env, "ANTHROPIC_API_KEY")).toBe(false);
      expect(Object.hasOwn(env, "CODEX_SELECTION_TEST_SECRET")).toBe(false);
      const credentialShaped = Object.keys(env).filter((key) =>
        CREDENTIAL_SHAPED.test(key),
      );
      expect(credentialShaped).toEqual([]);

      // Positive control, and it is what makes the three lines above mean
      // "filtered" instead of "nothing was passed at all": HOME — the variable
      // that decides whether the machine's Codex session is visible — does
      // arrive, with the value this process has.
      expect(env.HOME).toBe(process.env.HOME);
    });

    it("the turn's outcome is identical with and without the planted secret", async () => {
      const clean = await buildCodexByType().compress("sys", "user");
      resetState();
      process.env.CODEX_SELECTION_TEST_SECRET = "planted-by-the-test";
      const dirty = await buildCodexByType().compress("sys", "user");

      // This is the whole reason the case above asserts on CodexOptions and not
      // on the answer: the two runs differ in what the child could read, and
      // the observable result of the call is the same string either way.
      expect(dirty).toBe(clean);
      expect(Object.hasOwn(childEnvOf(), "CODEX_SELECTION_TEST_SECRET")).toBe(
        false,
      );
    });
  });

  // ---- channel 2: agent-sdk answering under the name of codex -------------
  describe("channel 2 — the key-less quadrant, both columns", () => {
    // `agent-sdk` shares the factory's `default` branch
    // (src/providers/index.ts), so ANY provider type that misses its `case`
    // silently becomes Claude-on-a-subscription. The answer arrives, it is
    // sensible, and nothing about it says which model produced it. Hence both
    // columns: what the configuration CHOSE, and what was actually BUILT.
    const quadrant: Array<{
      env: Record<string, string>;
      provider: string;
      name: string;
    }> = [
      { env: {}, provider: "noop", name: "noop" },
      {
        env: { AGENTMEMORY_ALLOW_AGENT_SDK: "true" },
        provider: "agent-sdk",
        name: "agent-sdk",
      },
      { env: { AGENTMEMORY_CODEX: "true" }, provider: "codex", name: "codex" },
      {
        env: { AGENTMEMORY_CODEX: "true", AGENTMEMORY_ALLOW_AGENT_SDK: "true" },
        provider: "codex",
        name: "codex",
      },
    ];

    for (const row of quadrant) {
      const label = Object.keys(row.env).length
        ? Object.entries(row.env)
            .map(([k, v]) => `${k}=${v}`)
            .join(" + ")
        : "neither opt-in";
      it(`${label} -> provider=${row.provider}, built=${row.name}`, () => {
        for (const [key, value] of Object.entries(row.env)) {
          process.env[key] = value;
        }
        const config = loadConfig().provider;
        expect(config.provider).toBe(row.provider);

        // The second column, and it can disagree with the first: a `case
        // "codex"` placed BELOW `default` would leave this at "agent-sdk" while
        // the line above still read "codex". A test that asserted only the
        // first column would pass against a completely broken factory.
        const built = createProvider(config);
        expect(baseOf(built).name).toBe(row.name);
        expect(built.name).toBe(`resilient(${row.name})`);
      });
    }

    it("positive control: an unknown provider type really does become agent-sdk", () => {
      // Without this the row above proves nothing about the danger it guards:
      // it shows the `default` branch is reachable and that it answers to the
      // name `agent-sdk`, i.e. that the "codex" rows are a real discrimination
      // and not a tautology.
      const built = createProvider({
        provider: "not-a-provider" as unknown as ProviderConfig["provider"],
        model: "irrelevant",
        maxTokens: 1024,
      });
      expect(baseOf(built).name).toBe("agent-sdk");
      expect(baseOf(built).name).not.toBe("codex");
    });
  });

  // ---- channel 3: a DeepSeek key under the OpenAI-family names ------------
  describe("channel 3 — the keyed provider's endpoint is never handed to Codex", () => {
    it("forwards neither apiKey nor baseUrl, and copies no OpenAI-family variable", async () => {
      // The live shape of this machine class: the keyed chat provider is
      // DeepSeek configured through the OpenAI-compatible variables
      // (src/config.ts detectProvider treats them as one branch). Codex is then
      // reached as a fallback target, not as the primary — which is why the
      // provider is built by type here.
      process.env.OPENAI_API_KEY = "sk-deepseek-planted-by-the-test";
      process.env.OPENAI_BASE_URL = "https://api.deepseek.com/v1";

      await buildCodexByType().compress("sys", "user");

      const options = codexOptions();
      expect(state.parentEnvDuringTurn?.OPENAI_BASE_URL).toBe(
        "https://api.deepseek.com/v1",
      );

      // `apiKey` and `baseUrl` are the ONLY two fields that can point the SDK
      // at another backend (`dist/index.d.ts:218-235`); the SDK reads neither
      // from the environment on its own. Absent keys, not undefined values: a
      // key present with `undefined` would mean the code touched the variable.
      expect(Object.hasOwn(options, "apiKey")).toBe(false);
      expect(Object.hasOwn(options, "baseUrl")).toBe(false);

      const leaked = Object.keys(childEnvOf()).filter((key) =>
        key.startsWith("OPENAI_"),
      );
      expect(leaked).toEqual([]);
      // Same positive control as channel 1: the object is populated, so the
      // empty list is a filter and not an empty env.
      expect(childEnvOf().HOME).toBe(process.env.HOME);
    });

    it("static: the provider's source names no OpenAI-family variable (И-2.1)", () => {
      // Structural half of the pair. Channel 3 is closed by the ABSENCE of
      // code, and absence is what regressions restore first — a single
      // `getEnvVar("OPENAI_BASE_URL")` added later would route a "Codex" turn
      // to api.deepseek.com, return a coherent answer, and break nothing any
      // behavioural assertion can see.
      const read = (relativePath: string) =>
        readFileSync(join(rootDir, relativePath), "utf8");
      const count = (text: string) => text.split("OPENAI_").length - 1;

      // Positive control first: a zero measured with a broken reader is
      // indistinguishable from a zero measured correctly (rule 22).
      expect(count(read("src/providers/openai.ts"))).toBeGreaterThan(0);
      expect(count(read("src/providers/codex.ts"))).toBe(0);
    });
  });

  // ---- the rest of the phase's checks -------------------------------------
  describe("supporting invariants", () => {
    it("constructing the provider resolves no SDK module (И-2.2)", () => {
      // Constructing resolved nothing, even a tick later.
      expect(sdkLoadsAfterConstruction).toBe(0);
      // The other half, on the same probe: the FIRST call does resolve it.
      // Without this reading, "zero loads" would also be what a mock that never
      // works at all reports — the same number for the invariant holding and
      // for nothing being measured.
      expect(sdkLoadsAfterFirstCall).toBe(1);
      expect(lazyProbeAnswer).toBe("<result>ok</result>");
    });

    it("omits ThreadOptions.model when no model is pinned (KD-3)", async () => {
      const config = (() => {
        process.env.AGENTMEMORY_CODEX = "true";
        return loadConfig().provider;
      })();
      expect(config.model).toBe(CODEX_DEFAULT_MODEL);

      await createProvider(config).compress("sys", "user");

      // Distinguishing: passing the sentinel through as a model name would send
      // Codex the literal `codex-default`, which no plan has — the user would
      // get "unknown model" instead of the model from their own
      // ~/.codex/config.toml. Both outcomes are "the provider was configured";
      // only this assertion separates them.
      expect(Object.hasOwn(state.threadOptions[0], "model")).toBe(false);
    });

    it("passes ThreadOptions.model through unchanged when one is pinned (KD-3)", async () => {
      process.env.AGENTMEMORY_CODEX = "true";
      process.env.AGENTMEMORY_CODEX_MODEL = "gpt-5.6-sol";
      const config = loadConfig().provider;
      expect(config.model).toBe("gpt-5.6-sol");

      await createProvider(config).compress("sys", "user");

      expect(state.threadOptions[0].model).toBe("gpt-5.6-sol");
    });

    it("carries the phase-3 guard fields on the object the factory assembles", async () => {
      process.env.AGENTMEMORY_CODEX = "true";
      const config = loadConfig().provider;

      await createProvider(config).compress("sys", "user");

      const servers = codexOptions().config?.mcp_servers;
      const entry = servers?.agentmemory;
      expect(entry?.enabled).toBe(false);
      // Control for the same assertion: the override names ONE server row. The
      // tempting shortcut `mcp_servers={}` was measured to leave the server
      // enabled, because `--config` merges rather than replaces — so an
      // override that addressed the whole table would be inert, and this
      // assertion is what separates the two shapes.
      expect(Object.keys(servers ?? {})).toEqual(["agentmemory"]);
      // The stub command is load-bearing, not decoration: `--config` MERGES, so
      // on a machine with no `[mcp_servers.agentmemory]` entry the override
      // CREATES one, and an entry without a transport makes the Codex CLI
      // refuse the whole config — exit 1 before any network call. Measured on
      // the pinned 0.146.1 binary; the negative control for it lives in
      // test/codex-provider.test.ts.
      expect(typeof entry?.command).toBe("string");
      expect((entry?.command as string).length).toBeGreaterThan(0);
      expect(state.threadOptions[0].approvalPolicy).toBe("never");
      // Set unconditionally rather than copied: supplying `env` stops the SDK
      // inheriting `process.env`, so a marker that merely happened to be set in
      // this process would not reach the child.
      expect(childEnvOf().AGENTMEMORY_SDK_CHILD).toBe("1");
    });
  });
});
