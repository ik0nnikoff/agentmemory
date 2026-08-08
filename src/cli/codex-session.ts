import { spawnSync } from "node:child_process";
import { resolveCodexBin } from "./codex-bin.js";

export type CodexSessionState =
  | { state: "logged-in" | "logged-out" }
  | { state: "error"; reason: string };

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Is there a Codex subscription session on this machine?
 *
 * 🔴 The answer is read from the EXIT CODE, never from the text: `stdio` is
 * `"ignore"`, so the child's output is not captured at all. That is at once the
 * "credentials are never logged" invariant (nothing to leak into a log) and
 * immunity to a localised or reworded status line. `~/.codex/auth.json` is not
 * read by us here or anywhere else.
 *
 * Measured on codex-cli 0.146.1: `login status` answers in ~0.19 s locally,
 * exit 0 with a session and exit 1 with an empty CODEX_HOME.
 *
 * The child inherits this process's environment (spec 3.4 prescribes no `env`
 * clause): it needs HOME/CODEX_HOME to find the session at all, there is no
 * untrusted input in a status check, and the process it starts is the Codex
 * binary itself. That is deliberately different from the app-server child in
 * `codex-catalog.ts`, which is handed the provider allowlist.
 *
 * `bin`/`timeoutMs` are injection points for tests; production callers pass
 * nothing.
 */
export function codexLoginStatus(opts?: {
  bin?: string;
  timeoutMs?: number;
}): CodexSessionState {
  let bin = opts?.bin;
  if (!bin) {
    const resolved = resolveCodexBin();
    if (!resolved.ok) return { state: "error", reason: resolved.reason };
    bin = resolved.path;
  }

  // Always `node <script>`: the resolved file is a .js script, not an
  // executable.
  const result = spawnSync(process.execPath, [bin, "login", "status"], {
    stdio: "ignore",
    timeout: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ETIMEDOUT") {
      return {
        state: "error",
        reason: `codex login status timed out after ${opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms`,
      };
    }
    return {
      state: "error",
      reason: `could not run codex login status: ${code ?? "spawn failed"}`,
    };
  }
  if (result.signal) {
    return {
      state: "error",
      reason: `codex login status was killed by ${result.signal}`,
    };
  }
  if (result.status === 0) return { state: "logged-in" };
  if (result.status === 1) return { state: "logged-out" };
  return {
    state: "error",
    reason: `codex login status exited with ${result.status ?? "no status"}`,
  };
}
