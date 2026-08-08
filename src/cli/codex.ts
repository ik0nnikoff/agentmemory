import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as p from "@clack/prompts";

import { resolveCodexBin } from "./codex-bin.js";
import {
  listCodexModels,
  type CodexCatalogResult,
  type CodexModel,
} from "./codex-catalog.js";
import { readCodexToml, type CodexTomlSettings } from "./codex-config-toml.js";
import { codexLoginStatus, type CodexSessionState } from "./codex-session.js";
import { parseEnvFile } from "./doctor-diagnostics.js";
import { setEnvKeys, type EnvWriteResult } from "./env-file.js";

/**
 * `agentmemory codex …` — signing in to Codex and steering the provider.
 *
 * 🔴 Name collision, and it is deliberate: `src/cli/connect/codex.ts` already
 * owns the word `codex` for the OPPOSITE direction — there Codex is the host
 * agent and agentmemory is wired into it. This file is agentmemory calling
 * Codex as its LLM provider. Two namespaces, one word; neither imports the
 * other.
 *
 * Everything this file can write lives in `~/.agentmemory/.env` and goes
 * through `setEnvKeys` (`env-file.ts`). Under the Codex home exactly one file
 * is ever opened, `config.toml`, and only for reading (`codex-config-toml.ts`);
 * the session credentials are never opened, parsed or printed — the session is
 * decided by the EXIT CODE of `codex login status` (`codex-session.ts`).
 */

/** The whole exit-code table of this command family (spec §2). */
export const CODEX_EXIT = {
  /** success / "yes" */
  ok: 0,
  /** a valid negative answer — `status` on a machine with no session */
  no: 1,
  /** usage error: unknown subcommand, unknown model, unsupported effort */
  usage: 2,
  /** environment error: no binary, no catalogue, `.env` not writable */
  environment: 3,
} as const;

export const CODEX_ENABLE_KEY = "AGENTMEMORY_CODEX";
export const CODEX_MODEL_KEY = "AGENTMEMORY_CODEX_MODEL";
export const CODEX_EFFORT_KEY = "AGENTMEMORY_CODEX_REASONING_EFFORT";

/**
 * 🔴 The ONE foreign key this command may write, and only after the operator
 * says yes (Р-2). Nothing else in `.env` is ever touched.
 */
const OPENAI_FOR_LLM_KEY = "OPENAI_API_KEY_FOR_LLM";
const OPENAI_KEY_NAME = "OPENAI_API_KEY";

const SUBCOMMANDS = [
  "status",
  "login",
  "logout",
  "enable",
  "disable",
  "model",
  "effort",
] as const;

/** What the running daemon answers about its own LLM provider. */
export type DaemonProvider =
  | { state: "known"; name: string }
  /** Reached it, but the answer carries no `llmProvider` — an older build. */
  | { state: "unknown" }
  | { state: "unreachable" };

export type CodexIo = {
  /** A data line of the command's own output. */
  out: (line: string) => void;
  info: (line: string) => void;
  warn: (line: string) => void;
  error: (line: string) => void;
  /** Is there a human at a terminal? Decides the Р-2 branch. */
  interactive: boolean;
  confirm: (message: string) => Promise<boolean>;
};

export type CodexDeps = {
  envPath: string;
  readEnvFile: () => Record<string, string>;
  writeEnvKeys: (updates: Record<string, string>) => EnvWriteResult;
  session: () => CodexSessionState;
  catalog: () => Promise<CodexCatalogResult>;
  readToml: (codexHome: string) => CodexTomlSettings;
  daemonProvider: () => Promise<DaemonProvider>;
  /** `login` / `logout`: runs the real CLI with inherited stdio, gives its code. */
  runInteractive: (subcommand: "login" | "logout") => Promise<number>;
  /** Used only when the app-server did not hand us a `codexHome`. */
  computedCodexHome: () => string;
  io: CodexIo;
};

/**
 * Entry point registered in the `commands` table of `src/cli.ts`.
 *
 * The exit code is published through `process.exitCode` rather than
 * `process.exit(code)`: stdout is a pipe whenever the output is captured, and
 * on POSIX a pipe write is asynchronous — `process.exit` would truncate the
 * very table the command exists to print.
 */
export async function runCodexCmd(argv: string[] = []): Promise<void> {
  process.exitCode = await runCodexCommand(argv, defaultCodexDeps());
}

export async function runCodexCommand(
  argv: string[],
  deps: CodexDeps,
): Promise<number> {
  // Global flags (`--verbose`, `-v`, …) are handled by src/cli.ts before the
  // dispatch and are none of our business here.
  const positional = argv.filter((arg) => !arg.startsWith("-"));
  // A bare `agentmemory codex` is `status` (spec §2).
  const sub = positional[0] ?? "status";
  const arg = positional[1];

  switch (sub) {
    case "status":
      return codexStatus(deps);
    case "login":
    case "logout":
      return codexLoginLogout(sub, deps);
    case "enable":
      return codexSetFlag(true, deps);
    case "disable":
      return codexSetFlag(false, deps);
    case "model":
      return codexModel(arg, deps);
    case "effort":
      return codexEffort(arg, deps);
    default:
      deps.io.error(
        `Unknown subcommand: ${sub}. Supported: ${SUBCOMMANDS.join(", ")}.`,
      );
      return CODEX_EXIT.usage;
  }
}

// ---------------------------------------------------------------- status ----

async function codexStatus(deps: CodexDeps): Promise<number> {
  const session = deps.session();
  // The catalogue call is what turns `codexHome` from a guess into a fact; it
  // is also the only thing here that costs a child process, so its failure is
  // reported in place and never fails the command.
  const catalog = await deps.catalog();
  const fromServer = catalog.ok && catalog.codexHome !== "" ? catalog.codexHome : "";
  const codexHome = fromServer !== "" ? fromServer : deps.computedCodexHome();
  const homeNote =
    fromServer !== ""
      ? `CODEX_HOME=${codexHome}`
      : `CODEX_HOME=${codexHome} — computed, not reported by codex app-server`;

  const env = deps.readEnvFile();
  const toml = deps.readToml(codexHome);
  const daemon = await deps.daemonProvider();

  const sessionText = describeSession(session);

  const flagInFile = env[CODEX_ENABLE_KEY];
  const daemonText =
    daemon.state === "known"
      ? daemon.name
      : daemon.state === "unknown"
        ? "unknown"
        : "not reachable";
  const daemonNote =
    daemon.state === "known"
      ? "running daemon's LLM provider"
      : daemon.state === "unknown"
        ? "daemon predates this field"
        : `no answer from the daemon's REST API`;

  const model = resolveSetting(env[CODEX_MODEL_KEY], toml.model, deps.envPath, codexHome);
  const effort = resolveSetting(
    env[CODEX_EFFORT_KEY],
    toml.reasoningEffort,
    deps.envPath,
    codexHome,
  );

  deps.io.out(row("Codex session", sessionText, homeNote));
  deps.io.out(
    row(
      CODEX_ENABLE_KEY,
      `file: ${flagInFile ?? "not set"}`,
      deps.envPath,
    ),
  );
  // 🔴 `file:` and `daemon:` are two different facts and never collapse into
  // one: `~/.agentmemory/.env` is parsed once per process
  // (`src/config.ts:36-45`, `envFileCache`), so a value just written here is
  // NOT what the running worker uses until it restarts.
  deps.io.out(row("", `daemon: ${daemonText}`, daemonNote));
  deps.io.out(row("Model", model.value, model.note));
  deps.io.out(row("Reasoning effort", effort.value, effort.note));

  if (!catalog.ok) {
    deps.io.warn(`Codex catalogue unavailable: ${catalog.reason}`);
  }

  if (session.state === "logged-in") return CODEX_EXIT.ok;
  if (session.state === "logged-out") return CODEX_EXIT.no;
  return CODEX_EXIT.environment;
}

function describeSession(session: CodexSessionState): string {
  // The error member is matched FIRST, positively: the other member's `state`
  // is itself a union of two literals, and excluding both does not narrow the
  // union down to the member that carries `reason`.
  //
  // 🔴 The reason is ours (a spawn/exit-code diagnosis of `codex-session.ts`),
  // never the child's output: that output is not captured at all.
  if (session.state === "error") return `could not check (${session.reason})`;
  return session.state === "logged-in" ? "logged in" : "logged out";
}

/**
 * The three states of model and of effort (spec §4.1). "Not set anywhere" is
 * `Codex decides` — never an invented model name.
 */
function resolveSetting(
  override: string | undefined,
  fromToml: string | undefined,
  envPath: string,
  codexHome: string,
): { value: string; note: string } {
  if (override !== undefined && override.trim() !== "") {
    return { value: override, note: `from ${envPath}` };
  }
  if (fromToml !== undefined && fromToml.trim() !== "") {
    return { value: fromToml, note: `from ${join(codexHome, "config.toml")}` };
  }
  return { value: "Codex decides", note: "no override, nothing in config.toml" };
}

function row(label: string, value: string, note: string): string {
  return `${label.padEnd(18)} ${value.padEnd(25)} (${note})`;
}

// --------------------------------------------------------- login / logout ----

async function codexLoginLogout(
  sub: "login" | "logout",
  deps: CodexDeps,
): Promise<number> {
  const code = await deps.runInteractive(sub);
  return code;
}

// -------------------------------------------------------- enable / disable ----

async function codexSetFlag(enable: boolean, deps: CodexDeps): Promise<number> {
  const env = deps.readEnvFile();
  const updates: Record<string, string> = {
    [CODEX_ENABLE_KEY]: enable ? "true" : "false",
  };

  if (enable) {
    // Precondition Р-2. The file is the source consulted here, because the file
    // is what the worker parses at boot (`src/config.ts:44-71`) and what this
    // command writes; a key exported in the operator's own shell says nothing
    // about the daemon's environment.
    const key = (env[OPENAI_KEY_NAME] ?? "").trim();
    if (key !== "" && env[OPENAI_FOR_LLM_KEY] !== "false") {
      deps.io.warn(
        `${OPENAI_KEY_NAME} is set in ${deps.envPath} and ${OPENAI_FOR_LLM_KEY} is not "false". ` +
          `The keyed branch wins earlier than codex (src/config.ts:101), so the chain never reaches ` +
          `codex: the flag would be set, no error would be raised, and the provider would not run.`,
      );
      if (deps.io.interactive) {
        const yes = await deps.io.confirm(
          `Also set ${OPENAI_FOR_LLM_KEY}=false so the codex branch is reachable?`,
        );
        // Written in the SAME setEnvKeys call: one backup, one atomic write.
        if (yes) updates[OPENAI_FOR_LLM_KEY] = "false";
        else
          deps.io.info(
            `Left ${OPENAI_FOR_LLM_KEY} alone. ${CODEX_ENABLE_KEY} is still being written.`,
          );
      } else {
        deps.io.info(
          `Not a terminal — ${OPENAI_FOR_LLM_KEY} is left untouched. Set it to false yourself, ` +
            `or re-run this command from a terminal.`,
        );
      }
    }
  }

  return writeEnvUpdates(updates, deps);
}

// ----------------------------------------------------------------- model ----

async function codexModel(name: string | undefined, deps: CodexDeps): Promise<number> {
  const catalog = await withSessionWarning(deps);
  if (!catalog.ok) {
    deps.io.error(`Could not read the Codex model catalogue: ${catalog.reason}`);
    return CODEX_EXIT.environment;
  }

  const visible = catalog.models.filter((m) => !m.hidden);

  if (name === undefined) {
    const env = deps.readEnvFile();
    const toml = deps.readToml(
      catalog.codexHome !== "" ? catalog.codexHome : deps.computedCodexHome(),
    );
    const current = env[CODEX_MODEL_KEY]?.trim() || toml.model?.trim() || "";
    for (const line of formatModelTable(visible, current)) deps.io.out(line);
    deps.io.info(
      "Model and reasoning effort are the main throughput lever here: wave 4 measured " +
        "`compress` at 27 372 ms with the concurrency ceiling at 1.",
    );
    return CODEX_EXIT.ok;
  }

  const match = findModel(catalog.models, name);
  if (!match) {
    // 🔴 Nothing is written on this path — the file is not opened at all.
    deps.io.error(
      `Codex does not offer a model called "${name}". Available: ${visible
        .map((m) => m.id)
        .join(", ")}.`,
    );
    return CODEX_EXIT.usage;
  }

  // The catalogue's own `model` field is what Codex expects to be handed back,
  // even when the operator selected the row by its `id`.
  return writeEnvUpdates({ [CODEX_MODEL_KEY]: match.model }, deps);
}

function formatModelTable(models: CodexModel[], current: string): string[] {
  const rows = models.map((m) => {
    const marks: string[] = [];
    if (m.isDefault) marks.push("Codex default");
    if (current !== "" && (m.id === current || m.model === current)) marks.push("current");
    return [m.id, m.displayName, m.defaultReasoningEffort, marks.join(", ")];
  });
  const header = ["model", "display name", "default effort", ""];
  const widths = [0, 1, 2].map((col) =>
    Math.max(header[col]!.length, ...rows.map((r) => r[col]!.length)),
  );
  const render = (cells: string[]): string =>
    `${cells[0]!.padEnd(widths[0]!)}  ${cells[1]!.padEnd(widths[1]!)}  ${cells[2]!.padEnd(
      widths[2]!,
    )}  ${cells[3]}`.trimEnd();
  return [render(header), ...rows.map(render)];
}

// ---------------------------------------------------------------- effort ----

async function codexEffort(level: string | undefined, deps: CodexDeps): Promise<number> {
  const catalog = await withSessionWarning(deps);
  if (!catalog.ok) {
    deps.io.error(`Could not read the Codex model catalogue: ${catalog.reason}`);
    return CODEX_EXIT.environment;
  }

  const env = deps.readEnvFile();
  const codexHome = catalog.codexHome !== "" ? catalog.codexHome : deps.computedCodexHome();
  const toml = deps.readToml(codexHome);

  // Which model this effort belongs to, in the order of spec §4.5. Effort is a
  // property of ONE model, so this resolution is load-bearing, not cosmetic.
  let current: CodexModel | undefined;
  let source = "";
  const pinned = env[CODEX_MODEL_KEY]?.trim();
  const inToml = toml.model?.trim();
  if (pinned) {
    current = findModel(catalog.models, pinned);
    source = deps.envPath;
    if (!current) {
      deps.io.error(
        `${CODEX_MODEL_KEY}=${pinned} (${deps.envPath}) names a model the Codex catalogue does not offer. ` +
          `Run \`agentmemory codex model\` for the list.`,
      );
      return CODEX_EXIT.usage;
    }
  } else if (inToml) {
    current = findModel(catalog.models, inToml);
    source = join(codexHome, "config.toml");
    if (!current) {
      deps.io.error(
        `model=${inToml} (${source}) names a model the Codex catalogue does not offer. ` +
          `Run \`agentmemory codex model\` for the list.`,
      );
      return CODEX_EXIT.usage;
    }
  } else {
    current = catalog.models.find((m) => m.isDefault);
    source = "Codex default";
    if (!current) {
      deps.io.error(
        "No model is pinned and the Codex catalogue names no default, so there is no model " +
          "whose reasoning efforts could be listed.",
      );
      return CODEX_EXIT.environment;
    }
  }

  const supported = current.supportedReasoningEfforts;

  if (level === undefined) {
    deps.io.out(`Model             ${current.id}  (${source})`);
    deps.io.out(`Default effort    ${current.defaultReasoningEffort}`);
    deps.io.out("Supported efforts");
    for (const option of supported) {
      deps.io.out(
        `  ${option.reasoningEffort.padEnd(10)} ${option.description}`.trimEnd(),
      );
    }
    if (supported.length === 0) {
      deps.io.warn(`Codex lists no reasoning efforts for ${current.id}.`);
    }
    return CODEX_EXIT.ok;
  }

  // Р-1: the catalogue of THIS model is the validator — not the TS union of the
  // SDK, which lacks values this catalogue offers and offers one no model does.
  if (!supported.some((option) => option.reasoningEffort === level)) {
    // 🔴 Nothing is written on this path — the file is not opened at all.
    deps.io.error(
      `${current.id} does not support reasoning effort "${level}". Supported by this model: ` +
        `${supported.map((o) => o.reasoningEffort).join(", ") || "none"}.`,
    );
    return CODEX_EXIT.usage;
  }

  return writeEnvUpdates({ [CODEX_EFFORT_KEY]: level }, deps);
}

// ----------------------------------------------------------------- shared ----

function findModel(models: CodexModel[], name: string): CodexModel | undefined {
  return models.find((m) => m.id === name || m.model === name);
}

/**
 * The catalogue cannot tell an authenticated run from an unauthenticated one:
 * without a session Codex answers with a DIFFERENT, smaller list rather than an
 * empty one. So the session is asked separately and the list is labelled.
 */
async function withSessionWarning(deps: CodexDeps): Promise<CodexCatalogResult> {
  const session = deps.session();
  if (session.state === "logged-out") {
    deps.io.warn(
      "No Codex session: the list below is the unauthenticated catalogue and will change " +
        "after `agentmemory codex login`.",
    );
  } else if (session.state === "error") {
    deps.io.warn(
      `Could not check the Codex session (${session.reason}); the list below may be the ` +
        "unauthenticated catalogue.",
    );
  }
  return deps.catalog();
}

function writeEnvUpdates(
  updates: Record<string, string>,
  deps: CodexDeps,
): number {
  const result = deps.writeEnvKeys(updates);
  if (!result.ok) {
    deps.io.error(result.reason);
    return CODEX_EXIT.environment;
  }
  const names = Object.keys(updates).join(", ");
  if (!result.changed) {
    deps.io.info(`${names}: already set as requested — ${deps.envPath} was not rewritten.`);
    return CODEX_EXIT.ok;
  }
  for (const [key, value] of Object.entries(updates)) {
    deps.io.out(`${key}=${value}`);
  }
  if (result.created) {
    // The curator's ruling: an empty backup path is not printed as a path.
    deps.io.info(`Created ${deps.envPath}.`);
  } else {
    deps.io.info(`Backup: ${result.backupPath}`);
  }
  if (result.duplicates > 0) {
    // The count only — never the values (env-file.ts rule 8).
    deps.io.warn(
      `${deps.envPath} held ${result.duplicates} un-commented lines for the keys just written; all were updated.`,
    );
  }
  deps.io.info(
    `This does NOT take effect until the agentmemory worker restarts: ~/.agentmemory/.env is ` +
      `parsed once per process (src/config.ts:36-45). Restart the agentmemory process the same ` +
      `way you started it.`,
  );
  return CODEX_EXIT.ok;
}

// ------------------------------------------------------------ real wiring ----

function defaultCodexDeps(): CodexDeps {
  const envPath = join(homedir(), ".agentmemory", ".env");
  return {
    envPath,
    readEnvFile: () => readEnvFileSafely(envPath),
    writeEnvKeys: (updates) => setEnvKeys(envPath, updates),
    session: () => codexLoginStatus(),
    catalog: () => listCodexModels(),
    readToml: (codexHome) => readCodexToml(codexHome),
    daemonProvider: fetchDaemonProvider,
    runInteractive: runCodexInteractively,
    computedCodexHome: () => process.env["CODEX_HOME"] || join(homedir(), ".codex"),
    io: {
      out: (line) => console.log(line),
      info: (line) => p.log.info(line),
      warn: (line) => p.log.warn(line),
      error: (line) => p.log.error(line),
      interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
      confirm: async (message) => {
        const answer = await p.confirm({ message, initialValue: false });
        return !p.isCancel(answer) && answer === true;
      },
    },
  };
}

function readEnvFileSafely(envPath: string): Record<string, string> {
  try {
    if (!existsSync(envPath)) return {};
    return parseEnvFile(readFileSync(envPath, "utf-8"));
  } catch {
    // Unreadable is reported by the write path with a real reason; the read
    // path must not print anything about the contents of this file.
    return {};
  }
}

/**
 * `login` / `logout` run with the FULL environment and inherited stdio.
 *
 * 🔴 Both are deliberate and both differ from the app-server child in
 * `codex-catalog.ts`:
 *   - stdio is inherited, not piped: capturing it would break the interactive
 *     sign-in and would put credentials one `console.log` away from a log file;
 *   - the environment is not the provider allowlist: opening the operator's
 *     browser needs a platform-specific and non-enumerable set (BROWSER,
 *     DISPLAY, XDG_*, SSH_*, …), there is a human at the terminal and there is
 *     no untrusted input on this path.
 */
async function runCodexInteractively(sub: "login" | "logout"): Promise<number> {
  const resolved = resolveCodexBin();
  if (!resolved.ok) {
    p.log.error(resolved.reason);
    return CODEX_EXIT.environment;
  }
  return new Promise<number>((resolve) => {
    // Always `node <script>`: the resolved file is a .js script.
    const child = spawn(process.execPath, [resolved.path, sub], {
      stdio: "inherit",
    });
    child.on("error", (err) => {
      p.log.error(`could not run codex ${sub}: ${err.message}`);
      resolve(CODEX_EXIT.environment);
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        p.log.error(`codex ${sub} was killed by ${signal}`);
        resolve(CODEX_EXIT.environment);
        return;
      }
      resolve(code ?? CODEX_EXIT.environment);
    });
  });
}

/**
 * What the RUNNING daemon says its LLM provider is — the only honest source for
 * the `daemon:` line, since the process that answers is the one holding the
 * memoized `.env`.
 *
 * The URL is derived the same way `src/cli.ts` derives it (AGENTMEMORY_URL,
 * else III_REST_PORT, else 3111); those helpers are module-private there.
 */
async function fetchDaemonProvider(): Promise<DaemonProvider> {
  const explicit = process.env["AGENTMEMORY_URL"];
  const port = parseInt(process.env["III_REST_PORT"] || "3111", 10) || 3111;
  const base = explicit ? explicit.replace(/\/+$/, "") : `http://localhost:${port}`;
  try {
    const headers: Record<string, string> = {};
    const secret = process.env["AGENTMEMORY_SECRET"];
    if (secret) headers["Authorization"] = `Bearer ${secret}`;
    const res = await fetch(`${base}/agentmemory/config/flags`, {
      signal: AbortSignal.timeout(3000),
      headers,
    });
    if (!res.ok) return { state: "unreachable" };
    const body = (await res.json()) as { llmProvider?: unknown };
    if (typeof body?.llmProvider === "string" && body.llmProvider !== "") {
      return { state: "known", name: body.llmProvider };
    }
    // Reached a daemon that does not carry the field: an installation older
    // than this build. That is an answer, not a failure.
    return { state: "unknown" };
  } catch {
    return { state: "unreachable" };
  }
}
