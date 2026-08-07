import type {
  MemoryProvider,
  ProviderConfig,
  FallbackConfig,
} from "../types.js";
import { AgentSDKProvider } from "./agent-sdk.js";
import { AnthropicProvider } from "./anthropic.js";
import { CODEX_DEFAULT_MODEL, CodexProvider } from "./codex.js";
import { MinimaxProvider } from "./minimax.js";
import { NoopProvider } from "./noop.js";
import { OpenAIProvider } from "./openai.js";
import { OpenRouterProvider } from "./openrouter.js";
import { ResilientProvider } from "./resilient.js";
import { FallbackChainProvider } from "./fallback-chain.js";
import { getEnvVar } from "../config.js";

export { createEmbeddingProvider, createImageEmbeddingProvider } from "./embedding/index.js";

function requireEnvVar(key: string): string {
  const value = getEnvVar(key);
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${key}. Set it in ~/.agentmemory/.env or as an environment variable.`,
    );
  }
  return value;
}

// #778: fallback providers used to inherit the primary provider's
// model name (e.g. fallback Gemini was called with `gpt-4o-mini`),
// 404'd every call, and tripped the circuit breaker — making
// FALLBACK_PROVIDERS actively worse than no fallback. Each provider
// must resolve its OWN env-driven default model. Mirrors the resolution
// in detectProvider() so primary + fallback agree on what each
// provider's default model is.
function defaultModelFor(providerType: ProviderConfig["provider"]): string {
  switch (providerType) {
    case "openai":
      return getEnvVar("OPENAI_MODEL") || "gpt-4o-mini";
    case "anthropic":
      return getEnvVar("ANTHROPIC_MODEL") || "claude-sonnet-4-20250514";
    case "gemini":
      return getEnvVar("GEMINI_MODEL") || "gemini-2.5-flash";
    case "openrouter":
      return (
        getEnvVar("OPENROUTER_MODEL") || "anthropic/claude-sonnet-4-20250514"
      );
    case "minimax":
      return getEnvVar("MINIMAX_MODEL") || "MiniMax-M2.7";
    case "agent-sdk":
      return "claude-sonnet-4-20250514";
    case "codex":
      return getEnvVar("AGENTMEMORY_CODEX_MODEL") || CODEX_DEFAULT_MODEL;
    case "noop":
    default:
      return "noop";
  }
}

// Re-exported, NOT declared here. The sentinel is owned by the provider that
// gives it meaning (`./codex.js`), so the dependency runs factory -> provider
// like every other provider in this file. Declaring it here instead made
// `codex.ts` import back from this module — the only provider that did — and
// that cycle only stayed harmless while the constant happened to be read inside
// a method body; a top-level read would have hit the ESM temporal dead zone.
export { CODEX_DEFAULT_MODEL } from "./codex.js";

export function createProvider(config: ProviderConfig): ResilientProvider {
  return new ResilientProvider(createBaseProvider(config));
}

export function createFallbackProvider(
  config: ProviderConfig,
  fallbackConfig: FallbackConfig,
): ResilientProvider {
  if (fallbackConfig.providers.length === 0) {
    return createProvider(config);
  }

  const providers: MemoryProvider[] = [createBaseProvider(config)];
  for (const providerType of fallbackConfig.providers) {
    if (providerType === config.provider) continue;
    try {
      // #778: resolve the fallback's OWN default model (or its env
      // override) rather than copying config.model from the primary.
      // Without this, FALLBACK_PROVIDERS=gemini on an OpenAI primary
      // would call Gemini with `gpt-4o-mini`, get a 404 every time,
      // and trip the circuit breaker.
      const fbConfig: ProviderConfig = {
        provider: providerType,
        model: defaultModelFor(providerType),
        maxTokens: config.maxTokens,
      };
      providers.push(createBaseProvider(fbConfig));
    } catch {
      // skip unavailable fallback providers
    }
  }

  if (providers.length > 1) {
    return new ResilientProvider(new FallbackChainProvider(providers));
  }
  return new ResilientProvider(providers[0]);
}

function createBaseProvider(config: ProviderConfig): MemoryProvider {
  switch (config.provider) {
    case "minimax":
      return new MinimaxProvider(
        requireEnvVar("MINIMAX_API_KEY"),
        config.model,
        config.maxTokens,
      );
    case "anthropic":
      return new AnthropicProvider(
        requireEnvVar("ANTHROPIC_API_KEY"),
        config.model,
        config.maxTokens,
        config.baseURL,
      );
    case "gemini": {
      const geminiKey =
        getEnvVar("GEMINI_API_KEY") || getEnvVar("GOOGLE_API_KEY");
      if (!geminiKey) {
        throw new Error(
          "GEMINI_API_KEY (or GOOGLE_API_KEY) is required for the gemini provider",
        );
      }
      return new OpenRouterProvider(
        geminiKey,
        config.model,
        config.maxTokens,
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      );
    }
    case "openrouter":
      return new OpenRouterProvider(
        requireEnvVar("OPENROUTER_API_KEY"),
        config.model,
        config.maxTokens,
        "https://openrouter.ai/api/v1/chat/completions",
      );
    case "openai": {
      const openaiKey = getEnvVar("OPENAI_API_KEY");
      if (!openaiKey) {
        throw new Error(
          "OPENAI_API_KEY is required for the openai provider",
        );
      }
      return new OpenAIProvider(
        openaiKey,
        config.model,
        config.maxTokens,
        config.baseURL,
      );
    }
    case "noop":
      return new NoopProvider();
    // Must stay ABOVE `agent-sdk`: that case shares the `default` branch and
    // catches every unknown provider type, so a `codex` case placed after it
    // is only reachable by accident of ordering.
    case "codex":
      return new CodexProvider(config);
    case "agent-sdk":
    default:
      return new AgentSDKProvider();
  }
}
