import { spawn } from "node:child_process";
import { CHILD_ENV_ALLOWLIST } from "../providers/codex.js";
import { VERSION } from "../version.js";
import { resolveCodexBin } from "./codex-bin.js";

export type CodexReasoningEffortOption = {
  reasoningEffort: string;
  description: string;
};

export type CodexModel = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  supportedReasoningEfforts: CodexReasoningEffortOption[];
  defaultReasoningEffort: string;
  isDefault: boolean;
  hidden: boolean;
};

export type CodexCatalogResult =
  | { ok: true; models: CodexModel[]; codexHome: string }
  | { ok: false; reason: string };

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Pagination stop. `model/list` answers with an opaque `nextCursor`
 * (`v2/ModelListResponse.json`); a server that keeps handing one back would
 * otherwise loop forever.
 */
const MAX_PAGES = 20;

/**
 * The model catalogue, asked of Codex itself — never a list of model names
 * kept in this repository.
 *
 * Transport is `codex app-server` over stdio with newline-delimited JSON-RPC.
 * It was chosen over `mcp-server` because the binary itself enumerates that
 * protocol (`codex app-server generate-json-schema`), so `model/list`,
 * its `cursor` parameter and the `data`/`nextCursor` shape of the answer are
 * facts read off the schema rather than guesses; measured round trip is
 * ~292 ms.
 *
 * 🔴 The catalogue does NOT tell you whether a session exists. Without one the
 * server answers with a DIFFERENT, smaller catalogue — not an empty one — so
 * callers must ask `codexLoginStatus()` (`codex-session.ts`) separately and
 * warn that the list corresponds to the unauthenticated mode.
 *
 * `bin`/`timeoutMs` are injection points for tests; production callers pass
 * nothing.
 */
export async function listCodexModels(opts?: {
  timeoutMs?: number;
  bin?: string;
}): Promise<CodexCatalogResult> {
  let bin = opts?.bin;
  if (!bin) {
    const resolved = resolveCodexBin();
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    bin = resolved.path;
  }
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // stderr is dropped rather than piped: the child's diagnostics are not ours
  // to log, and this keeps the "nothing from Codex is ever written to our
  // output" invariant true by construction.
  const child = spawn(process.execPath, [bin, "app-server"], {
    stdio: ["pipe", "pipe", "ignore"],
    env: codexChildEnv(),
  });

  const pending = new Map<
    number,
    { resolve: (value: Record<string, unknown>) => void; reject: (err: Error) => void }
  >();
  let nextId = 1;
  let aborted = false;

  // One rejection channel for everything that can end the conversation from
  // outside a request: process error, early exit, timeout.
  let abortWith: (err: Error) => void = () => {};
  const aborting = new Promise<never>((_, reject) => {
    abortWith = (err: Error) => {
      if (aborted) return;
      aborted = true;
      for (const entry of pending.values()) entry.reject(err);
      pending.clear();
      reject(err);
    };
  });
  // Nobody races this promise once the happy path has returned; without a sink
  // its later rejection would surface as an unhandled rejection.
  aborting.catch(() => {});

  const timer = setTimeout(() => {
    abortWith(new Error(`codex app-server did not answer within ${timeoutMs} ms`));
  }, timeoutMs);
  timer.unref?.();

  child.on("error", (err) => {
    abortWith(new Error(`could not run codex app-server: ${err.message}`));
  });
  child.on("exit", (code, signal) => {
    abortWith(
      new Error(
        `codex app-server exited before answering (${signal ? `signal ${signal}` : `code ${code}`})`,
      ),
    );
  });

  let buffer = "";
  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line === "") continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // not JSON-RPC (banner, log line) — ignore it
      }
      const record = asRecord(message);
      if (!record || typeof record["id"] !== "number") continue; // notification
      const entry = pending.get(record["id"]);
      if (!entry) continue;
      pending.delete(record["id"]);
      const failure = asRecord(record["error"]);
      if (failure) {
        entry.reject(new Error(describeRpcError(failure)));
        continue;
      }
      entry.resolve(asRecord(record["result"]) ?? {});
    }
  });

  const request = (
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const id = nextId++;
    const answer = new Promise<Record<string, unknown>>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch (err) {
        pending.delete(id);
        reject(new Error(`could not write to codex app-server: ${errorText(err)}`));
      }
    });
    return Promise.race([answer, aborting]);
  };

  try {
    const initialize = await request("initialize", {
      clientInfo: { name: "agentmemory", version: VERSION },
    });
    // A direct fact from the server, not a guessed `~/.codex`
    // (`v1/InitializeResponse.json` requires `codexHome`).
    const codexHome =
      typeof initialize["codexHome"] === "string" ? initialize["codexHome"] : "";

    const models: CodexModel[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const listed = await request("model/list", cursor === null ? {} : { cursor });
      // `data` and nothing else: `v2/ModelListResponse.json`, generated by the
      // binary itself, declares `data` required and has no `models` field at
      // all. A second branch for a name the schema does not know would be dead
      // code pretending to be tolerance.
      const rows = Array.isArray(listed["data"]) ? listed["data"] : [];
      for (const row of rows) {
        const model = toModel(row);
        if (model) models.push(model);
      }
      const next = listed["nextCursor"];
      cursor = typeof next === "string" && next !== "" ? next : null;
      if (cursor === null) return { ok: true, models, codexHome };
    }
    return {
      ok: false,
      reason: `codex app-server kept paginating past ${MAX_PAGES} pages of model/list`,
    };
  } catch (err) {
    return { ok: false, reason: errorText(err) };
  } finally {
    clearTimeout(timer);
    // Every exit path kills the child, including the thrown one.
    try {
      child.stdin.end();
    } catch {
      // stdin already gone with the process.
    }
    child.kill("SIGTERM");
  }
}

/**
 * The child gets exactly the variables the Codex provider hands its own child
 * — the allowlist is imported, never copied, so a future narrowing there
 * narrows this too. Not extended.
 *
 * There is no untrusted input on this path (two read-only methods, no turn), so
 * the allowlist is not strictly necessary here; it is applied because
 * `hydrateProcessEnvFromFile()` (`src/cli.ts:91`) has already merged every
 * other provider's key into this process's environment, and a process that has
 * no business with them should not receive them.
 */
function codexChildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function toModel(row: unknown): CodexModel | null {
  const record = asRecord(row);
  if (!record) return null;
  const id = typeof record["id"] === "string" ? record["id"] : "";
  const model = typeof record["model"] === "string" ? record["model"] : id;
  if (id === "" && model === "") return null;
  const efforts: CodexReasoningEffortOption[] = [];
  const rawEfforts = record["supportedReasoningEfforts"];
  if (Array.isArray(rawEfforts)) {
    for (const option of rawEfforts) {
      const entry = asRecord(option);
      const effort =
        entry && typeof entry["reasoningEffort"] === "string"
          ? entry["reasoningEffort"]
          : typeof option === "string"
            ? option
            : "";
      if (effort === "") continue;
      efforts.push({
        reasoningEffort: effort,
        description:
          entry && typeof entry["description"] === "string" ? entry["description"] : "",
      });
    }
  }
  return {
    id: id === "" ? model : id,
    model,
    displayName:
      typeof record["displayName"] === "string" ? record["displayName"] : id === "" ? model : id,
    description: typeof record["description"] === "string" ? record["description"] : "",
    supportedReasoningEfforts: efforts,
    defaultReasoningEffort:
      typeof record["defaultReasoningEffort"] === "string" ? record["defaultReasoningEffort"] : "",
    isDefault: record["isDefault"] === true,
    hidden: record["hidden"] === true,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function describeRpcError(failure: Record<string, unknown>): string {
  const code = typeof failure["code"] === "number" ? failure["code"] : "unknown";
  const message =
    typeof failure["message"] === "string" ? failure["message"].slice(0, 200) : "no message";
  return `codex app-server rejected the request (code ${code}): ${message}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
