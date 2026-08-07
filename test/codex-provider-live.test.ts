import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { userInfo, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Phase 3, И-3.1 and layer B — on the ASSEMBLED provider, with a REAL turn.
//
// Everything in test/codex-provider.test.ts mocks `@openai/codex-sdk`, so it
// can only prove which options the provider BUILDS. Two claims of this phase
// are not about options at all and a mock cannot reach them:
//
//   И-3.1  the turn contains no `mcp_tool_call` on the `agentmemory` server —
//          a property of `turn.items`, produced by the Rust CLI;
//   layer B `approvalPolicy: "never"` resolves an approval request into a
//          REFUSAL in headless mode, not into automatic consent. The SDK
//          documents no such guarantee (`ApprovalMode` lists four values with
//          no semantics), so the only source is measurement.
//
// This file is excluded from `npm test` (vitest.config.ts) and runs only with
// AGENTMEMORY_CODEX_LIVE=1. It costs two real turns on the operator's ChatGPT
// subscription and spawns two real `codex exec` children — that is why it is
// opt-in rather than skipped-by-default: a skipped suite still moves the
// suite's own baseline counts, and this one must not.
//
// Instrumentation, deliberately minimal: `Thread.prototype.run` of the SAME
// module instance the provider imports is wrapped. It READS `this._exec` — the
// object the PROVIDER itself built — so the assertions below are about the real
// provider's configuration, not about a config retyped in this file. Only the
// control half writes, and it writes exactly one thing: it removes our MCP
// override, which is the single difference between the two halves.
// ---------------------------------------------------------------------------

type Capture = {
  configOverrides: any;
  threadOptions: any;
  childEnv: Record<string, string> | undefined;
  items: Array<{ type: string; [key: string]: any }>;
  finalResponse: string;
  elapsedMs: number;
};

const SYSTEM_PROMPT =
  "You are a probe used by an automated recursion-guard check. " +
  "Follow the instruction literally, do not ask questions, do not modify anything.";

const USER_PROMPT =
  "Call the MCP tool `memory_sessions` on the MCP server named `agentmemory`. " +
  "Then answer with exactly one line: CALLED=ok if the call returned data, " +
  "CALLED=unavailable if the tool or the server is not available to you. " +
  "Do not read or write files, do not run commands.";

/** Verbatim from the SDK's own item stream. A turn that never reaches the model
 * carries none of these, which is why the control half exists. */
function itemsOfType(capture: Capture, type: string) {
  return capture.items.filter((item) => item.type === type);
}

function realHome(): string {
  // NOT `process.env.HOME`: vitest.config.ts pins HOME to test/fixtures/fake-home
  // for the whole suite, and research measured what that does to a live turn —
  // 401 after 28.3 s, the sign-in session living in the real home being the
  // single difference. `userInfo()` reads the password database, not the
  // environment, so it survives that pin.
  return userInfo().homedir;
}

function codexConfigText(): string {
  const path = join(realHome(), ".codex", "config.toml");
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

const live = process.env.AGENTMEMORY_CODEX_LIVE === "1";

/**
 * The measurement itself, written to the path in
 * AGENTMEMORY_CODEX_LIVE_REPORT when one is given. A live check whose evidence
 * exists only as a green tick is a check whose numbers cannot be re-read later
 * — and the numbers (which item types appeared, which MCP calls, with which
 * status) are the whole point of running this at all.
 */
const measurements: Array<Record<string, unknown>> = [];

function record(half: string, capture: Capture, extra: Record<string, unknown> = {}) {
  const entry = {
    half,
    at: new Date().toISOString(),
    elapsedMs: capture.elapsedMs,
    itemTypes: capture.items.map((item) => item.type),
    mcpCalls: itemsOfType(capture, "mcp_tool_call").map((call) => ({
      server: call.server,
      tool: call.tool,
      status: call.status,
      error: call.error,
    })),
    configOverrides: capture.configOverrides,
    approvalPolicy: capture.threadOptions?.approvalPolicy,
    childEnvKeys: Object.keys(capture.childEnv ?? {}).sort(),
    finalResponse: capture.finalResponse.slice(0, 200),
    ...extra,
  };
  measurements.push(entry);
  console.log(`[live ${half}] ${JSON.stringify(entry)}`);
}

describe.skipIf(!live)("CodexProvider recursion guard on a live turn (И-3.1, layer B)", () => {
  let dataDir: string;
  let previousHome: string | undefined;
  let previousDataDir: string | undefined;
  let previousTimeout: string | undefined;
  let restoreRun: (() => void) | undefined;
  let stripOverride = false;
  let capture: Capture;
  let CodexProvider: typeof import("../src/providers/codex.js").CodexProvider;
  let CODEX_DEFAULT_MODEL: string;

  beforeAll(async () => {
    previousHome = process.env.HOME;
    previousDataDir = process.env.AGENTMEMORY_DATA_DIR;
    previousTimeout = process.env.AGENTMEMORY_CODEX_TIMEOUT_MS;
    process.env.HOME = realHome();
    dataDir = mkdtempSync(join(tmpdir(), "codex-live-guard-"));
    process.env.AGENTMEMORY_DATA_DIR = dataDir;
    // The measured turns took 18-41 s, and the control half additionally waits
    // for the MCP server to start. The provider's own 90 s default would turn a
    // slow-but-correct turn into `codex_timeout`, which answers nothing here.
    process.env.AGENTMEMORY_CODEX_TIMEOUT_MS = "180000";

    const sdk = await import("@openai/codex-sdk");
    const codexModule = await import("../src/providers/codex.js");
    CodexProvider = codexModule.CodexProvider;
    CODEX_DEFAULT_MODEL = codexModule.CODEX_DEFAULT_MODEL;

    const originalRun = sdk.Thread.prototype.run;
    sdk.Thread.prototype.run = async function patchedRun(
      this: any,
      input: any,
      turnOptions: any,
    ) {
      capture.configOverrides = structuredClone(this._exec.configOverrides ?? null);
      capture.threadOptions = this._threadOptions;
      capture.childEnv = this._exec.envOverride;
      if (stripOverride) {
        // The control's ONLY difference: layer A off. A fresh object, never a
        // mutation — the override the provider passes is a module-level
        // constant, and mutating it would silently disarm the guard half too.
        const { mcp_servers: servers, ...rest } = this._exec.configOverrides ?? {};
        const { agentmemory: _dropped, ...otherServers } = servers ?? {};
        this._exec.configOverrides = { ...rest, mcp_servers: otherServers };
        capture.configOverrides = structuredClone(this._exec.configOverrides);
      }
      const startedAt = Date.now();
      const turn = await originalRun.call(this, input, turnOptions);
      capture.elapsedMs = Date.now() - startedAt;
      capture.items = (turn.items ?? []) as Capture["items"];
      capture.finalResponse = turn.finalResponse ?? "";
      return turn;
    } as typeof sdk.Thread.prototype.run;

    restoreRun = () => {
      sdk.Thread.prototype.run = originalRun;
    };
  });

  afterAll(() => {
    restoreRun?.();
    const reportPath = process.env.AGENTMEMORY_CODEX_LIVE_REPORT;
    if (reportPath) {
      writeFileSync(reportPath, `${JSON.stringify(measurements, null, 2)}\n`, "utf8");
    }
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousDataDir === undefined) delete process.env.AGENTMEMORY_DATA_DIR;
    else process.env.AGENTMEMORY_DATA_DIR = previousDataDir;
    if (previousTimeout === undefined) delete process.env.AGENTMEMORY_CODEX_TIMEOUT_MS;
    else process.env.AGENTMEMORY_CODEX_TIMEOUT_MS = previousTimeout;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  function freshCapture(): Capture {
    return {
      configOverrides: undefined,
      threadOptions: undefined,
      childEnv: undefined,
      items: [],
      finalResponse: "",
      elapsedMs: 0,
    };
  }

  function newProvider() {
    return new CodexProvider({
      provider: "codex",
      model: CODEX_DEFAULT_MODEL,
      maxTokens: 1024,
    });
  }

  it(
    "guard half: no mcp_tool_call reaches the agentmemory server (И-3.1)",
    async () => {
      capture = freshCapture();
      stripOverride = false;

      const answer = await newProvider().compress(SYSTEM_PROMPT, USER_PROMPT);

      // What the PROVIDER built, read off the object it handed the SDK. Without
      // this half the run would only show that some turn had no MCP traffic,
      // not that our override is what kept it out.
      expect(capture.configOverrides?.mcp_servers?.agentmemory?.enabled).toBe(false);
      expect(typeof capture.configOverrides?.mcp_servers?.agentmemory?.command).toBe("string");
      expect(capture.threadOptions?.approvalPolicy).toBe("never");
      expect(capture.childEnv?.AGENTMEMORY_SDK_CHILD).toBe("1");
      // Layer C reaches the child only through this object: with `env` supplied
      // the SDK copies nothing from `process.env` (`dist/index.js:233-242`).
      expect(Object.keys(capture.childEnv ?? {})).toContain("PATH");

      // И-3.1 itself, on `turn.items` rather than on the model's self-report.
      // The plan records why: a run whose PATH lacked `npx` also produced
      // "CALLED=unavailable" while the channel was wide open.
      expect(itemsOfType(capture, "mcp_tool_call")).toEqual([]);
      // Positive control that a turn happened at all — a dead provider produces
      // zero items and would pass the assertion above trivially.
      expect(itemsOfType(capture, "agent_message").length).toBeGreaterThan(0);
      expect(answer.length).toBeGreaterThan(0);

      record("guard", capture);
    },
    600_000,
  );

  it(
    "control half: with layer A off the same policy REFUSES the call, it does not approve it (layer B)",
    async (ctx) => {
      if (!codexConfigText().includes("[mcp_servers.agentmemory]")) {
        // Honest skip, not a silent pass: with no server registered there is
        // nothing for `"never"` to refuse, so this machine cannot answer the
        // question either way.
        ctx.skip();
        return;
      }
      capture = freshCapture();
      stripOverride = true;

      await newProvider()
        .compress(SYSTEM_PROMPT, USER_PROMPT)
        .catch((error: Error) => `threw: ${error.message}`);

      // Layer A really is off in this half — otherwise the two halves would
      // differ in nothing and the comparison would measure noise.
      expect(capture.configOverrides?.mcp_servers?.agentmemory).toBeUndefined();
      expect(capture.threadOptions?.approvalPolicy).toBe("never");

      const mcpCalls = itemsOfType(capture, "mcp_tool_call");
      // Two things at once. (a) The positive control for the guard half: on
      // this machine, under this PATH, an enabled server DOES produce
      // `mcp_tool_call` items — so the zero above is the override working, not
      // an artefact of the model never trying. (b) Layer B: the call is present
      // and FAILED. If `"never"` meant "approve automatically", this item would
      // carry a completed status instead, and layer B would be worthless.
      expect(mcpCalls.length).toBeGreaterThan(0);
      expect(mcpCalls.map((call) => call.server)).toContain("agentmemory");
      for (const call of mcpCalls) {
        expect(call.status).not.toBe("completed");
      }

      record("control", capture);
    },
    600_000,
  );
});

// ---------------------------------------------------------------------------
// Phase 5 — authorization as a user-visible process, on REAL turns.
//
// The mocked suite proves the classifier's shape; it cannot prove the only
// thing this phase actually promises, because the promise is about a string
// this repository does not own: the 401 text comes from api.openai.com through
// the Rust CLI's NDJSON. Two halves, and the pair is the whole point —
//
//   isolated HOME (empty mkdtemp, no session)  -> the provider throws
//                                                 `codex_unauthorized` and one
//                                                 warning reaches stderr;
//   live HOME (the operator IS signed in)      -> the same code returns text
//                                                 and warns about nothing.
//
// A single run on the live HOME proves nothing at all: on this machine a
// session exists, so "success" is the answer regardless of what the code does.
// The isolated half alone proves nothing either — a provider broken in any way
// also fails to answer. Only the pair separates "no session" from "no
// provider".
//
// Ordering is load-bearing: the live half runs FIRST, while the once-per-process
// flags are still unburnt, so its "no warning was printed" assertion measures
// the code rather than a flag some earlier test already flipped.
//
// Cost: two more real turns (~27 s answering, ~28 s to be refused). Same opt-in
// switch as the block above.
// ---------------------------------------------------------------------------

const AUTH_MARK = "no ChatGPT/Codex session";

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

describe.skipIf(!live)(
  "CodexProvider authorization diagnosis on live turns (Ф5, S-4)",
  () => {
    let dataDir: string;
    let isolatedHome: string;
    let previousHome: string | undefined;
    let previousCodexHome: string | undefined;
    let previousDataDir: string | undefined;
    let previousTimeout: string | undefined;
    let CodexProvider: typeof import("../src/providers/codex.js").CodexProvider;
    let CODEX_DEFAULT_MODEL: string;

    beforeAll(async () => {
      previousHome = process.env.HOME;
      previousCodexHome = process.env.CODEX_HOME;
      previousDataDir = process.env.AGENTMEMORY_DATA_DIR;
      previousTimeout = process.env.AGENTMEMORY_CODEX_TIMEOUT_MS;
      dataDir = mkdtempSync(join(tmpdir(), "codex-live-auth-"));
      isolatedHome = mkdtempSync(join(tmpdir(), "codex-live-nohome-"));
      process.env.AGENTMEMORY_DATA_DIR = dataDir;
      process.env.AGENTMEMORY_CODEX_TIMEOUT_MS = "180000";

      const codexModule = await import("../src/providers/codex.js");
      CodexProvider = codexModule.CodexProvider;
      CODEX_DEFAULT_MODEL = codexModule.CODEX_DEFAULT_MODEL;
    });

    afterAll(() => {
      const reportPath = process.env.AGENTMEMORY_CODEX_LIVE_REPORT;
      if (reportPath) {
        writeFileSync(reportPath, `${JSON.stringify(measurements, null, 2)}\n`, "utf8");
      }
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
      if (previousDataDir === undefined) delete process.env.AGENTMEMORY_DATA_DIR;
      else process.env.AGENTMEMORY_DATA_DIR = previousDataDir;
      if (previousTimeout === undefined) delete process.env.AGENTMEMORY_CODEX_TIMEOUT_MS;
      else process.env.AGENTMEMORY_CODEX_TIMEOUT_MS = previousTimeout;
      if (dataDir) rmSync(dataDir, { recursive: true, force: true });
      if (isolatedHome) rmSync(isolatedHome, { recursive: true, force: true });
    });

    function newProvider() {
      return new CodexProvider({
        provider: "codex",
        model: CODEX_DEFAULT_MODEL,
        maxTokens: 1024,
      });
    }

    it(
      "signed-in half: the same code answers and warns about nothing",
      async () => {
        process.env.HOME = realHome();
        delete process.env.CODEX_HOME;

        const startedAt = Date.now();
        const capture = captureStderr();
        let answer: string;
        try {
          answer = await newProvider().compress(
            "Answer with one short line and nothing else.",
            "Reply with exactly: OK",
          );
        } finally {
          capture.restore();
        }
        const elapsedMs = Date.now() - startedAt;

        expect(answer.length).toBeGreaterThan(0);
        // The control half of the pair below: with a session present the
        // diagnosis must stay silent, so the warning there is caused by the
        // missing session and not by the provider warning on every call.
        expect(capture.lines.filter((line) => line.includes(AUTH_MARK))).toEqual([]);

        measurements.push({
          half: "phase5-signed-in",
          at: new Date().toISOString(),
          elapsedMs,
          home: "live",
          answerPrefix: answer.slice(0, 120),
          warnings: capture.lines.length,
        });
        console.log(
          `[live phase5-signed-in] ${JSON.stringify({ elapsedMs, answer: answer.slice(0, 120) })}`,
        );
      },
      600_000,
    );

    it(
      "no-session half: an empty HOME yields codex_unauthorized and one readable warning",
      async () => {
        // An empty mkdtemp, not the suite's fake-home fixture: the fixture is
        // shared with other suites and its contents are somebody else's
        // decision. CODEX_HOME is cleared too — it overrides HOME for exactly
        // this lookup, so leaving it set would isolate nothing while looking
        // like it did.
        process.env.HOME = isolatedHome;
        delete process.env.CODEX_HOME;

        const startedAt = Date.now();
        const capture = captureStderr();
        let message: string;
        try {
          message = await newProvider()
            .compress("Answer with one short line and nothing else.", "Reply with exactly: OK")
            .then((answer) => `resolved: ${answer}`)
            .catch((error: Error) => error.message);
        } finally {
          capture.restore();
        }
        const elapsedMs = Date.now() - startedAt;

        const warnings = capture.lines.filter((line) => line.includes(AUTH_MARK));

        measurements.push({
          half: "phase5-no-session",
          at: new Date().toISOString(),
          elapsedMs,
          home: "isolated",
          thrown: message,
          warning: warnings[0]?.trim() ?? null,
          otherStderr: capture.lines
            .filter((line) => !line.includes(AUTH_MARK))
            .map((line) => line.trim()),
        });
        console.log(
          `[live phase5-no-session] ${JSON.stringify({ elapsedMs, message, warnings })}`,
        );

        // The outcome, on the real upstream text rather than on a string this
        // file made up. `codex_bad_install` here would mean the positional
        // classifier fires on a healthy installation; a plain SDK error would
        // mean the substring no longer matches what the server sends.
        expect(message).toContain("codex_unauthorized");
        expect(message).not.toContain("codex_bad_install");
        // И-5.4: recognising the 401 changed the wording, not the outcome.
        expect(message.startsWith("resolved")).toBe(false);
        // И-5.5 / И-5.3: exactly one line, and it went through a channel that
        // survives quiet mode.
        expect(warnings.length).toBe(1);
        expect(warnings[0].startsWith("[agentmemory] warn ")).toBe(true);
        expect(warnings[0]).toContain("401");
        expect(warnings[0]).toContain("api.openai.com");
        // И-5.1 on the REAL response: the live 401 carries `cf-ray` and a
        // request id, and the mocked suite could only assert this against a
        // string it fabricated itself.
        expect(capture.text()).not.toContain("cf-ray");
        expect(capture.text()).not.toContain("request id");
        expect(capture.text()).not.toContain("auth.json");
      },
      600_000,
    );
  },
);
