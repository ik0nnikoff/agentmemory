import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  loadConfig,
  loadFallbackConfig,
  detectLlmProviderKind,
} from "../src/config";
import { createFallbackProvider } from "../src/providers/index";
import { CODEX_DEFAULT_MODEL } from "../src/providers/codex";

// Every env name either chain of src/config.ts reads while picking a provider.
// Cleared before each case: the suite runs on the pinned HOME from
// vitest.config.ts (test/fixtures/fake-home, no .env), but a real
// OPENAI_API_KEY in the runner's process.env would still win through
// getMergedEnv() and send every case into the openai branch.
const SELECTION_ENVS = [
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
  "FALLBACK_PROVIDERS",
  "MAX_TOKENS",
] as const;

describe("provider selection with the codex opt-in (wave 4, phase 6)", () => {
  const saved: Record<string, string | undefined> = {};
  const realStderrWrite = process.stderr.write.bind(process.stderr);
  let stderrText = "";

  beforeEach(() => {
    for (const k of SELECTION_ENVS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    // detectProvider() writes an advisory line on the key-less paths. Capture
    // it instead of letting it into the test output; one case asserts on it.
    stderrText = "";
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrText += typeof chunk === "string" ? chunk : String(chunk);
      return true;
    }) as unknown as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = realStderrWrite;
    for (const k of SELECTION_ENVS) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  });

  // И-6.1. The flag must not re-point installs that already have a key.
  // Difference that matters: with the codex branch placed ABOVE the key
  // branches all five of these return "codex" — a test that only asserts
  // "codex gets selected" passes in that broken order too.
  describe("an API key still wins over AGENTMEMORY_CODEX=true (И-6.1)", () => {
    const keyed: Array<[string, string, string]> = [
      ["OPENAI_API_KEY", "sk-test", "openai"],
      ["MINIMAX_API_KEY", "mm-test", "minimax"],
      ["ANTHROPIC_API_KEY", "sk-ant-test", "anthropic"],
      ["GEMINI_API_KEY", "gm-test", "gemini"],
      ["OPENROUTER_API_KEY", "or-test", "openrouter"],
    ];

    for (const [envName, value, expected] of keyed) {
      it(`${envName} -> ${expected}`, () => {
        process.env[envName] = value;
        process.env["AGENTMEMORY_CODEX"] = "true";
        // Keeps the openrouter premium-model advisory out of the assertion
        // surface; unrelated to selection.
        process.env["AGENTMEMORY_SUPPRESS_COST_WARNING"] = "1";
        expect(loadConfig().provider.provider).toBe(expected);
      });
    }
  });

  // И-6.2 / И-6.3. The whole key-less quadrant, including the tie.
  it("no keys and no flags -> noop (И-6.2)", () => {
    expect(loadConfig().provider.provider).toBe("noop");
  });

  it("AGENTMEMORY_CODEX=true alone -> codex", () => {
    process.env["AGENTMEMORY_CODEX"] = "true";
    expect(loadConfig().provider.provider).toBe("codex");
  });

  it("AGENTMEMORY_ALLOW_AGENT_SDK=true alone -> agent-sdk", () => {
    process.env["AGENTMEMORY_ALLOW_AGENT_SDK"] = "true";
    expect(loadConfig().provider.provider).toBe("agent-sdk");
  });

  it("both key-less opt-ins -> codex wins (И-6.3)", () => {
    process.env["AGENTMEMORY_CODEX"] = "true";
    process.env["AGENTMEMORY_ALLOW_AGENT_SDK"] = "true";
    expect(loadConfig().provider.provider).toBe("codex");
  });

  it("only the literal 'true' turns the opt-in on", () => {
    process.env["AGENTMEMORY_CODEX"] = "1";
    expect(loadConfig().provider.provider).toBe("noop");
  });

  it("the zero-LLM advisory names the codex opt-in", () => {
    expect(loadConfig().provider.provider).toBe("noop");
    expect(stderrText).toContain("AGENTMEMORY_CODEX=true");
  });

  // И-6.4. Both resolutions read the same sentinel, so the assertion is that
  // the two call sites agree — not that either equals a literal spelled here.
  describe("detectProvider and defaultModelFor agree on the codex model (И-6.4)", () => {
    // defaultModelFor() is module-private in providers/index.ts. The only way
    // to observe what it resolved for `codex` is the provider instance built
    // from it: createFallbackProvider returns
    // ResilientProvider(FallbackChainProvider([primary, ...fallbacks])).
    function codexModelFromFallbackChain(): string {
      const cfg = loadConfig();
      const chain = createFallbackProvider(cfg.provider, loadFallbackConfig());
      const inner = (
        chain as unknown as { inner: { providers: Array<{ name: string }> } }
      ).inner;
      const codex = inner.providers.find((p) => p.name === "codex");
      expect(codex, "codex must be reachable as a fallback target").toBeDefined();
      return (codex as unknown as { model: string }).model;
    }

    it("with AGENTMEMORY_CODEX_MODEL unset", () => {
      process.env["FALLBACK_PROVIDERS"] = "codex";
      const primaryModel = (() => {
        process.env["AGENTMEMORY_CODEX"] = "true";
        const m = loadConfig().provider.model;
        delete process.env["AGENTMEMORY_CODEX"];
        return m;
      })();
      expect(primaryModel).toBe(CODEX_DEFAULT_MODEL);
      expect(codexModelFromFallbackChain()).toBe(primaryModel);
    });

    it("with AGENTMEMORY_CODEX_MODEL set", () => {
      process.env["AGENTMEMORY_CODEX_MODEL"] = "gpt-5.6-sol";
      process.env["FALLBACK_PROVIDERS"] = "codex";
      const primaryModel = (() => {
        process.env["AGENTMEMORY_CODEX"] = "true";
        const m = loadConfig().provider.model;
        delete process.env["AGENTMEMORY_CODEX"];
        return m;
      })();
      expect(primaryModel).toBe("gpt-5.6-sol");
      expect(codexModelFromFallbackChain()).toBe(primaryModel);
    });
  });

  // И-6.5. VALID_PROVIDERS is module-private; loadFallbackConfig() is the
  // filter that consumes it, so the set is measured through its output.
  it("FALLBACK_PROVIDERS accepts exactly the 7 non-noop providers (И-6.5)", () => {
    process.env["AGENTMEMORY_ALLOW_AGENT_SDK"] = "true";
    process.env["FALLBACK_PROVIDERS"] =
      "anthropic,gemini,openrouter,agent-sdk,minimax,openai,codex,noop,nonsense";
    const { providers } = loadFallbackConfig();
    expect(providers).toEqual([
      "anthropic",
      "gemini",
      "openrouter",
      "agent-sdk",
      "minimax",
      "openai",
      "codex",
    ]);
    expect(providers).toHaveLength(7);
    expect(providers).not.toContain("noop");
  });

  it("codex is a legal fallback target without any opt-in flag", () => {
    process.env["FALLBACK_PROVIDERS"] = "codex";
    expect(loadFallbackConfig().providers).toEqual(["codex"]);
  });

  // И-6.6. The two parallel chains must not disagree.
  describe("detectLlmProviderKind tracks detectProvider (И-6.6)", () => {
    it("AGENTMEMORY_CODEX=true reports an LLM", () => {
      process.env["AGENTMEMORY_CODEX"] = "true";
      expect(detectLlmProviderKind()).toBe("llm");
    });

    it("no keys and no codex flag still reports noop", () => {
      expect(detectLlmProviderKind()).toBe("noop");
    });

    it("no environment yields kind=noop while the provider is codex", () => {
      const matrix: Array<Record<string, string>> = [
        {},
        { AGENTMEMORY_CODEX: "true" },
        { AGENTMEMORY_CODEX: "false" },
        { AGENTMEMORY_CODEX: "true", AGENTMEMORY_ALLOW_AGENT_SDK: "true" },
        { AGENTMEMORY_CODEX: "true", ANTHROPIC_API_KEY: "sk-ant-test" },
        { AGENTMEMORY_ALLOW_AGENT_SDK: "true" },
      ];
      for (const env of matrix) {
        for (const k of SELECTION_ENVS) delete process.env[k];
        for (const [k, v] of Object.entries(env)) process.env[k] = v;
        const provider = loadConfig().provider.provider;
        const kind = detectLlmProviderKind();
        expect(
          provider === "codex" && kind === "noop",
          `env ${JSON.stringify(env)} gave provider=${provider} kind=${kind}`,
        ).toBe(false);
      }
    });
  });
});
