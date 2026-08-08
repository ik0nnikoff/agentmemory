import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CODEX_EFFORT_KEY,
  CODEX_ENABLE_KEY,
  CODEX_EXIT,
  CODEX_MODEL_KEY,
  runCodexCommand,
  type CodexDeps,
  type DaemonProvider,
} from "../src/cli/codex.js";
import { parseEnvFile } from "../src/cli/doctor-diagnostics.js";
import { setEnvKeys } from "../src/cli/env-file.js";
import type { CodexCatalogResult, CodexModel } from "../src/cli/codex-catalog.js";
import type { CodexSessionState } from "../src/cli/codex-session.js";
import type { CodexTomlSettings } from "../src/cli/codex-config-toml.js";

// The `.env` under test is a synthetic file in a temp directory: the real
// ~/.agentmemory/.env is neither read nor written by this suite. The session,
// the catalogue and the daemon are stubs — no live Codex, no network.
//
// Model names, effort names and the key values below are invented. This
// repository holds zero real model names, in source and in assertions alike.

const FAKE_CODEX_HOME = "/fake/codex/home";

/**
 * Two models with DIFFERENT effort lists. That difference is the whole point of
 * Р-1: an effort is a property of one model, not of Codex.
 */
const ALPHA: CodexModel = {
  id: "alpha-one",
  model: "alpha-one",
  displayName: "Alpha One",
  description: "first",
  supportedReasoningEfforts: [
    { reasoningEffort: "low", description: "fast" },
    { reasoningEffort: "high", description: "slow" },
  ],
  defaultReasoningEffort: "low",
  isDefault: true,
  hidden: false,
};

const BETA: CodexModel = {
  id: "beta-one",
  model: "beta-one",
  displayName: "Beta One",
  description: "second",
  supportedReasoningEfforts: [
    { reasoningEffort: "low", description: "fast" },
    { reasoningEffort: "ultra", description: "very slow" },
  ],
  defaultReasoningEffort: "low",
  isDefault: false,
  hidden: false,
};

const HIDDEN: CodexModel = {
  ...ALPHA,
  id: "gamma-hidden",
  model: "gamma-hidden",
  displayName: "Gamma Hidden",
  isDefault: false,
  hidden: true,
};

const ENV_FIXTURE = [
  "# sample file, no real credentials",
  "# AGENTMEMORY_CODEX=true",
  "SOME_OTHER_KEY=untouched",
  "",
].join("\n");

let sandbox: string;
let envPath: string;
let out: string[];
let warned: string[];
let errored: string[];
let infos: string[];
let confirmAnswer: boolean;
let confirmPrompts: string[];
let interactive: boolean;
let session: CodexSessionState;
let catalog: CodexCatalogResult;
let toml: CodexTomlSettings;
let daemon: DaemonProvider;
let interactiveRuns: string[];

function deps(overrides: Partial<CodexDeps> = {}): CodexDeps {
  return {
    envPath,
    readEnvFile: () =>
      existsSync(envPath) ? parseEnvFile(readFileSync(envPath, "utf-8")) : {},
    writeEnvKeys: (updates) => setEnvKeys(envPath, updates),
    session: () => session,
    catalog: async () => catalog,
    readToml: () => toml,
    daemonProvider: async () => daemon,
    runInteractive: async (sub) => {
      interactiveRuns.push(sub);
      return 0;
    },
    computedCodexHome: () => FAKE_CODEX_HOME,
    io: {
      out: (line) => out.push(line),
      info: (line) => infos.push(line),
      warn: (line) => warned.push(line),
      error: (line) => errored.push(line),
      interactive,
      confirm: async (message) => {
        confirmPrompts.push(message);
        return confirmAnswer;
      },
    },
    ...overrides,
  };
}

/** Everything printed, in one string — the command's whole visible surface. */
function printed(): string {
  return [...out, ...infos, ...warned, ...errored].join("\n");
}

function envFile(): Record<string, string> {
  return parseEnvFile(readFileSync(envPath, "utf-8"));
}

function backups(): string[] {
  return readdirSync(sandbox).filter((name) => name.includes(".bak-"));
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "codex-cmd-test-"));
  envPath = join(sandbox, ".env");
  writeFileSync(envPath, ENV_FIXTURE);
  out = [];
  warned = [];
  errored = [];
  infos = [];
  confirmAnswer = false;
  confirmPrompts = [];
  interactive = false;
  session = { state: "logged-in" };
  catalog = { ok: true, models: [ALPHA, BETA, HIDDEN], codexHome: FAKE_CODEX_HOME };
  toml = {};
  daemon = { state: "known", name: "codex" };
  interactiveRuns = [];
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("agentmemory codex — dispatch", () => {
  it("treats a bare invocation as status", async () => {
    const code = await runCodexCommand([], deps());

    expect(code).toBe(CODEX_EXIT.ok);
    expect(out[0]).toContain("Codex session");
  });

  it("answers an unknown subcommand with exit 2 and the list of the supported ones", async () => {
    const code = await runCodexCommand(["frobnicate"], deps());

    expect(code).toBe(CODEX_EXIT.usage);
    expect(errored.join("\n")).toContain("frobnicate");
    for (const sub of ["login", "logout", "status", "enable", "disable", "model", "effort"]) {
      expect(errored.join("\n")).toContain(sub);
    }
    // Nothing was written on a usage error.
    expect(backups()).toEqual([]);
    expect(readFileSync(envPath, "utf-8")).toBe(ENV_FIXTURE);
  });

  it("hands login and logout to the interactive runner and passes its exit code back", async () => {
    const codeIn = await runCodexCommand(["login"], deps());
    const codeOut = await runCodexCommand(
      ["logout"],
      deps({
        runInteractive: async (sub) => {
          interactiveRuns.push(sub);
          return 7;
        },
      }),
    );

    expect(interactiveRuns).toEqual(["login", "logout"]);
    expect(codeIn).toBe(0);
    expect(codeOut).toBe(7);
  });
});

describe("agentmemory codex status", () => {
  it("separates the flag in the file from the flag in the running daemon", async () => {
    writeFileSync(envPath, `${CODEX_ENABLE_KEY}=false\n`);
    daemon = { state: "known", name: "codex" };

    await runCodexCommand(["status"], deps());

    const text = printed();
    expect(text).toContain("file: false");
    expect(text).toContain("daemon: codex");
  });

  it("says the daemon predates the field when the answer carries no name", async () => {
    daemon = { state: "unknown" };

    await runCodexCommand(["status"], deps());

    expect(printed()).toContain("daemon: unknown");
    expect(printed()).toContain("predates this field");
  });

  it("says not reachable when the daemon does not answer", async () => {
    daemon = { state: "unreachable" };

    await runCodexCommand(["status"], deps());

    expect(printed()).toContain("daemon: not reachable");
  });

  it("shows the three states of model and effort, and invents no model name", async () => {
    // 1. Override in .env wins.
    writeFileSync(envPath, `${CODEX_MODEL_KEY}=alpha-one\n`);
    toml = { model: "beta-one", reasoningEffort: "ultra" };
    await runCodexCommand(["status"], deps());
    expect(printed()).toContain(`alpha-one`);
    expect(printed()).toContain(envPath);

    // 2. No override, config.toml has it.
    out = [];
    infos = [];
    warned = [];
    errored = [];
    writeFileSync(envPath, ENV_FIXTURE);
    await runCodexCommand(["status"], deps());
    expect(printed()).toContain("beta-one");
    expect(printed()).toContain(join(FAKE_CODEX_HOME, "config.toml"));

    // 3. Neither: the honest answer, not a made-up name.
    out = [];
    infos = [];
    warned = [];
    errored = [];
    toml = {};
    await runCodexCommand(["status"], deps());
    const text = printed();
    expect(text).toContain("Codex decides");
    expect(text).not.toContain("alpha-one");
    expect(text).not.toContain("beta-one");
  });

  it("marks CODEX_HOME as computed when the app-server did not report one", async () => {
    catalog = { ok: false, reason: "codex app-server did not answer within 15000 ms" };

    const code = await runCodexCommand(["status"], deps());

    expect(printed()).toContain("computed");
    // A failed catalogue does not decide the exit code: the session does.
    expect(code).toBe(CODEX_EXIT.ok);
  });

  it("distinguishes no session (1) from could not check (3)", async () => {
    session = { state: "logged-out" };
    expect(await runCodexCommand(["status"], deps())).toBe(CODEX_EXIT.no);

    session = { state: "error", reason: "codex login status exited with 2" };
    expect(await runCodexCommand(["status"], deps())).toBe(CODEX_EXIT.environment);
  });
});

describe("agentmemory codex enable / disable", () => {
  it("writes the flag in place, keeps every other line, and names the backup", async () => {
    const code = await runCodexCommand(["enable"], deps());

    expect(code).toBe(CODEX_EXIT.ok);
    expect(envFile()[CODEX_ENABLE_KEY]).toBe("true");
    expect(readFileSync(envPath, "utf-8")).toContain("SOME_OTHER_KEY=untouched");
    // The commented sample line is not an occurrence, so it survives verbatim.
    expect(readFileSync(envPath, "utf-8")).toContain(`# ${CODEX_ENABLE_KEY}=true`);
    expect(backups().length).toBe(1);
    expect(infos.join("\n")).toContain("Backup:");
    // 🔴 The restart note is not decoration: the worker memoizes the file.
    expect(infos.join("\n")).toContain("restart");
  });

  it("says already-set on the second call, writes nothing and takes no backup", async () => {
    await runCodexCommand(["enable"], deps());
    const afterFirst = readFileSync(envPath, "utf-8");
    infos = [];

    const code = await runCodexCommand(["enable"], deps());

    expect(code).toBe(CODEX_EXIT.ok);
    expect(readFileSync(envPath, "utf-8")).toBe(afterFirst);
    expect(backups().length).toBe(1);
    expect(infos.join("\n")).toContain("already set");
  });

  it("disable writes false", async () => {
    await runCodexCommand(["disable"], deps());

    expect(envFile()[CODEX_ENABLE_KEY]).toBe("false");
  });

  it("Р-2, no TTY: warns about the keyed branch and leaves the second key alone", async () => {
    writeFileSync(envPath, "OPENAI_API_KEY=sk-not-a-real-key\n");
    interactive = false;

    const code = await runCodexCommand(["enable"], deps());

    expect(code).toBe(CODEX_EXIT.ok);
    expect(confirmPrompts).toEqual([]);
    expect(warned.join("\n")).toContain("OPENAI_API_KEY_FOR_LLM");
    expect(envFile()[CODEX_ENABLE_KEY]).toBe("true");
    expect(envFile()["OPENAI_API_KEY_FOR_LLM"]).toBeUndefined();
  });

  it("Р-2, TTY + yes: writes both keys in ONE call, so there is ONE backup", async () => {
    writeFileSync(envPath, "OPENAI_API_KEY=sk-not-a-real-key\n");
    interactive = true;
    confirmAnswer = true;

    await runCodexCommand(["enable"], deps());

    expect(confirmPrompts.length).toBe(1);
    expect(envFile()[CODEX_ENABLE_KEY]).toBe("true");
    expect(envFile()["OPENAI_API_KEY_FOR_LLM"]).toBe("false");
    expect(backups().length).toBe(1);
  });

  it("Р-2, TTY + no: the flag is still written, the second key is not", async () => {
    writeFileSync(envPath, "OPENAI_API_KEY=sk-not-a-real-key\n");
    interactive = true;
    confirmAnswer = false;

    await runCodexCommand(["enable"], deps());

    expect(envFile()[CODEX_ENABLE_KEY]).toBe("true");
    expect(envFile()["OPENAI_API_KEY_FOR_LLM"]).toBeUndefined();
  });

  it("does not raise the question at all when the keyed branch cannot win", async () => {
    writeFileSync(
      envPath,
      ["OPENAI_API_KEY=sk-not-a-real-key", "OPENAI_API_KEY_FOR_LLM=false", ""].join("\n"),
    );
    interactive = true;

    await runCodexCommand(["enable"], deps());

    expect(confirmPrompts).toEqual([]);
    expect(warned).toEqual([]);
  });

  it("reads OPENAI_API_KEY_FOR_LLM=false through an inline comment, as the daemon does", async () => {
    // The line as it stands in a real file: the value is followed by a comment.
    // The daemon's parser ends the value at the first ` #`; a CLI parser that
    // kept the comment inside the value compared "false   # …" against "false",
    // decided the keyed branch still wins, and warned about a state that does
    // not exist. That warning is what this test forbids.
    writeFileSync(
      envPath,
      [
        "OPENAI_API_KEY=sk-synthetic-not-real",
        "OPENAI_API_KEY_FOR_LLM=false                   # LLM OFF, some date",
        "",
      ].join("\n"),
    );
    interactive = true;

    const code = await runCodexCommand(["enable"], deps());

    expect(code).toBe(CODEX_EXIT.ok);
    expect(warned).toEqual([]);
    expect(confirmPrompts).toEqual([]);
    expect(envFile()[CODEX_ENABLE_KEY]).toBe("true");
  });

  it("positive control: the same file WITHOUT =false does warn", async () => {
    // Same shape, same inline comment, one value changed. Without this pair the
    // test above would pass just as well on a command that never warns at all.
    writeFileSync(
      envPath,
      [
        "OPENAI_API_KEY=sk-synthetic-not-real",
        "OPENAI_API_KEY_FOR_LLM=true                    # LLM ON, some date",
        "",
      ].join("\n"),
    );
    interactive = true;

    await runCodexCommand(["enable"], deps());

    expect(warned.join("\n")).toContain("OPENAI_API_KEY_FOR_LLM");
    expect(confirmPrompts.length).toBe(1);
  });

  it("reports a .env that cannot be written as an environment error (3)", async () => {
    const code = await runCodexCommand(
      ["enable"],
      deps({ writeEnvKeys: () => ({ ok: false, reason: "could not update AGENTMEMORY_CODEX: EACCES" }) }),
    );

    expect(code).toBe(CODEX_EXIT.environment);
    expect(errored.join("\n")).toContain("EACCES");
  });
});

describe("agentmemory codex model", () => {
  it("lists what Codex offers, hides hidden rows, and marks the default", async () => {
    const code = await runCodexCommand(["model"], deps());

    expect(code).toBe(CODEX_EXIT.ok);
    const text = out.join("\n");
    expect(text).toContain("alpha-one");
    expect(text).toContain("beta-one");
    expect(text).not.toContain("gamma-hidden");
    expect(text).toContain("Codex default");
  });

  it("marks the pinned model as current", async () => {
    writeFileSync(envPath, `${CODEX_MODEL_KEY}=beta-one\n`);

    await runCodexCommand(["model"], deps());

    const betaRow = out.find((line) => line.startsWith("beta-one"));
    expect(betaRow).toContain("current");
  });

  it("warns that the list is the unauthenticated one when there is no session", async () => {
    session = { state: "logged-out" };

    await runCodexCommand(["model"], deps());

    expect(warned.join("\n")).toContain("unauthenticated");
    // The list is still shown — the unauthenticated catalogue is not empty.
    expect(out.join("\n")).toContain("alpha-one");
  });

  it("rejects a model Codex does not offer with exit 2 and writes nothing (§6.6)", async () => {
    const before = readFileSync(envPath, "utf-8");

    const code = await runCodexCommand(["model", "no-such-model"], deps());

    expect(code).toBe(CODEX_EXIT.usage);
    expect(readFileSync(envPath, "utf-8")).toBe(before);
    expect(backups()).toEqual([]);
    expect(errored.join("\n")).toContain("no-such-model");
  });

  it("writes the pinned model when the catalogue confirms it", async () => {
    const code = await runCodexCommand(["model", "beta-one"], deps());

    expect(code).toBe(CODEX_EXIT.ok);
    expect(envFile()[CODEX_MODEL_KEY]).toBe("beta-one");
  });

  it("turns an unreachable catalogue into exit 3 without touching the file", async () => {
    catalog = { ok: false, reason: "could not run codex app-server: ENOENT" };
    const before = readFileSync(envPath, "utf-8");

    const code = await runCodexCommand(["model", "beta-one"], deps());

    expect(code).toBe(CODEX_EXIT.environment);
    expect(readFileSync(envPath, "utf-8")).toBe(before);
    expect(backups()).toEqual([]);
  });
});

describe("agentmemory codex effort", () => {
  it("lists the efforts of the model that is actually selected", async () => {
    writeFileSync(envPath, `${CODEX_MODEL_KEY}=beta-one\n`);

    const code = await runCodexCommand(["effort"], deps());

    expect(code).toBe(CODEX_EXIT.ok);
    const text = out.join("\n");
    expect(text).toContain("beta-one");
    expect(text).toContain("ultra");
    // `high` belongs to the OTHER model and must not appear here.
    expect(text).not.toContain("high");
  });

  it("falls back model -> config.toml -> catalogue default, in that order", async () => {
    toml = { model: "beta-one" };
    await runCodexCommand(["effort"], deps());
    expect(out.join("\n")).toContain("beta-one");

    out = [];
    toml = {};
    await runCodexCommand(["effort"], deps());
    // Nothing pinned anywhere: the catalogue's own default model, alpha-one.
    expect(out.join("\n")).toContain("alpha-one");
  });

  it("accepts an effort the selected model supports and writes it (§6.5)", async () => {
    const code = await runCodexCommand(["effort", "high"], deps());

    expect(code).toBe(CODEX_EXIT.ok);
    expect(envFile()[CODEX_EFFORT_KEY]).toBe("high");
  });

  it("rejects an effort no model offers, with exit 2 and no write (§6.5)", async () => {
    const before = readFileSync(envPath, "utf-8");

    const code = await runCodexCommand(["effort", "bogus-effort"], deps());

    expect(code).toBe(CODEX_EXIT.usage);
    expect(readFileSync(envPath, "utf-8")).toBe(before);
    expect(backups()).toEqual([]);
    expect(errored.join("\n")).toContain("bogus-effort");
  });

  it("rejects an effort that ANOTHER model supports but the current one does not (Р-1, §6.5)", async () => {
    // `ultra` is real — beta-one offers it — and the current model is alpha-one,
    // which does not. A validator built on a global list of effort names would
    // accept this and would be green on exactly the defect this test exists for.
    const before = readFileSync(envPath, "utf-8");

    const code = await runCodexCommand(["effort", "ultra"], deps());

    expect(code).toBe(CODEX_EXIT.usage);
    expect(readFileSync(envPath, "utf-8")).toBe(before);
    expect(backups()).toEqual([]);
    expect(errored.join("\n")).toContain("alpha-one");
    // Positive control on the same value: pin the model that DOES offer it and
    // the same call goes through.
    writeFileSync(envPath, `${CODEX_MODEL_KEY}=beta-one\n`);
    expect(await runCodexCommand(["effort", "ultra"], deps())).toBe(CODEX_EXIT.ok);
    expect(envFile()[CODEX_EFFORT_KEY]).toBe("ultra");
  });

  it("rejects a pinned model the catalogue does not know, before any effort check", async () => {
    writeFileSync(envPath, `${CODEX_MODEL_KEY}=no-such-model\n`);
    const before = readFileSync(envPath, "utf-8");

    const code = await runCodexCommand(["effort", "low"], deps());

    expect(code).toBe(CODEX_EXIT.usage);
    expect(readFileSync(envPath, "utf-8")).toBe(before);
    expect(errored.join("\n")).toContain("no-such-model");
  });

  it("turns an unreachable catalogue into exit 3 without touching the file", async () => {
    catalog = { ok: false, reason: "could not run codex app-server: ENOENT" };
    const before = readFileSync(envPath, "utf-8");

    const code = await runCodexCommand(["effort", "low"], deps());

    expect(code).toBe(CODEX_EXIT.environment);
    expect(readFileSync(envPath, "utf-8")).toBe(before);
  });
});

describe("agentmemory codex — invariants", () => {
  it("keeps zero model names in the source of the command module", () => {
    const source = readFileSync(new URL("../src/cli/codex.ts", import.meta.url), "utf-8");
    expect(source.length).toBeGreaterThan(0); // positive control on the same read
    expect(source).toMatch(/codex/i); // positive control: the word IS there
    expect(source).not.toMatch(/gpt-/i);
  });

  it("opens no credential file: no readFileSync of anything under the Codex home", () => {
    // The only file this module reads by itself is ~/.agentmemory/.env; the
    // Codex home is reached exclusively through readCodexToml(), which reads
    // config.toml and nothing else. Positive control first, on the same read.
    const source = readFileSync(new URL("../src/cli/codex.ts", import.meta.url), "utf-8");
    expect(source).toMatch(/readFileSync/);
    expect(source.match(/readFileSync\(/g)?.length).toBe(1);
    const toml = readFileSync(
      new URL("../src/cli/codex-config-toml.ts", import.meta.url),
      "utf-8",
    );
    expect(toml).toMatch(/config\.toml/);
    expect(toml.match(/readFileSync\(/g)?.length).toBe(1);
  });
});
