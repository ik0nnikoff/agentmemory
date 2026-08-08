import { createRequire } from "node:module";

/**
 * Where the Codex CLI actually lives for THIS installation.
 *
 * 🔴 Resolution goes through the module resolver only — never through PATH.
 * `command -v codex`, `which codex` and `npm root -g` all answer with whatever
 * installation happens to sit first in the operator's PATH, which is a
 * different copy than the one this process would load (defect D-18: the npm
 * prefix is derived from the `node` that runs npm, so a second Node on PATH
 * silently hands back a foreign install). `createRequire(...).resolve()` answers
 * with the file the running process itself would load, which is the only answer
 * that matches the SDK's own behaviour.
 *
 * The resolved file is a plain `.js` script, NOT an executable binary: callers
 * must always start it as `spawn(process.execPath, [path, ...args])`.
 */
const CODEX_BIN_SPECIFIER = "@openai/codex/bin/codex.js";

export type CodexBinResult =
  | { ok: true; path: string }
  | { ok: false; reason: string };

/**
 * `resolve` is injectable for tests only. Production callers pass nothing and
 * get the resolver of this module.
 */
export function resolveCodexBin(opts?: {
  resolve?: (specifier: string) => string;
}): CodexBinResult {
  const resolve = opts?.resolve ?? createRequire(import.meta.url).resolve;
  try {
    return { ok: true, path: resolve(CODEX_BIN_SPECIFIER) };
  } catch {
    // The MODULE_NOT_FOUND stack never reaches the operator: it names a chain
    // of node_modules paths that explains nothing about the real cause. The
    // real cause is the packaging of the dependency, so say that instead.
    return {
      ok: false,
      reason:
        `Codex CLI not found (${CODEX_BIN_SPECIFIER} is not resolvable). ` +
        "`@openai/codex` arrives as a dependency of `@openai/codex-sdk`, and the " +
        "executable itself ships in a per-platform package " +
        "(`@openai/codex-<platform>-<arch>`) listed under optionalDependencies — " +
        "so it is absent on an unsupported platform, and also when the install " +
        "ran with optional dependencies disabled. Reinstall agentmemory with " +
        "optional dependencies enabled on a platform Codex publishes for.",
    };
  }
}
