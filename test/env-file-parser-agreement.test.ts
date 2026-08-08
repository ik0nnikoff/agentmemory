import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseEnvFileContent } from "../src/config.js";
import { parseEnvFile } from "../src/cli/doctor-diagnostics.js";

// One file, one grammar. `~/.agentmemory/.env` used to be parsed by TWO
// implementations — `loadEnvFile` in src/config.ts (the daemon's) and
// `parseEnvFile` in src/cli/doctor-diagnostics.ts (the CLI's) — and they
// disagreed on the two forms that occur in the operator's real file: an inline
// `# comment` after an unquoted value, and a quoted value. The daemon read
// `KEY=false   # note` as "false"; the CLI read it as "false   # note", and
// every comparison against a literal then went the other way depending on which
// parser happened to be called.
//
// These tests compare the two functions' OUTPUT on one input rather than
// restating an expectation by hand: a hand-written expectation would have to be
// updated twice on a future divergence and would then keep passing.

/** Values are invented; no credential and no model name appears here. */
const CORPUS = [
  "# a leading comment line",
  "",
  "PLAIN=value",
  "INLINE_COMMENT=false                   # switched off on some date",
  "QUOTED=\"quoted value\"",
  "QUOTED_WITH_COMMENT=\"quoted value\"   # trailing note",
  "SINGLE='single quoted'",
  "SPACED_KEY = spaced value",
  "EMPTY=",
  "HASH_NO_SPACE=value#not-a-comment",
  "UNTERMINATED=\"still open",
  "EQUALS_IN_VALUE=a=b=c",
  "   # indented comment",
  "NOT_AN_ASSIGNMENT",
  "CRLF_LINE=value\r",
  "",
].join("\n");

describe("~/.agentmemory/.env — one parser, two callers", () => {
  it("the CLI's parseEnvFile answers exactly what the daemon's parser answers", () => {
    const daemon = parseEnvFileContent(CORPUS);
    const cli = parseEnvFile(CORPUS);

    expect(cli).toEqual(daemon);

    // Positive controls on the very forms the two used to disagree about: if
    // the corpus stopped exercising them, the equality above would still pass
    // and would prove nothing.
    expect(daemon["INLINE_COMMENT"]).toBe("false");
    expect(daemon["QUOTED"]).toBe("quoted value");
    expect(daemon["QUOTED_WITH_COMMENT"]).toBe("quoted value");
    expect(daemon["HASH_NO_SPACE"]).toBe("value#not-a-comment");
    expect(daemon["CRLF_LINE"]).toBe("value");
  });

  it("agrees line by line, so a future divergence names the line that broke", () => {
    for (const line of CORPUS.split("\n")) {
      expect(parseEnvFile(line)).toEqual(parseEnvFileContent(line));
    }
  });
});

describe("~/.agentmemory/.env — the CLI reads what the running daemon reads", () => {
  let sandboxHome: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env["HOME"];
    sandboxHome = mkdtempSync(join(tmpdir(), "env-parser-home-"));
    mkdirSync(join(sandboxHome, ".agentmemory"));
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previousHome;
    rmSync(sandboxHome, { recursive: true, force: true });
    vi.resetModules();
  });

  it("getEnvVar and parseEnvFile give the same value for every key of one file", async () => {
    writeFileSync(join(sandboxHome, ".agentmemory", ".env"), CORPUS);
    // src/config.ts resolves ENV_FILE from homedir() at module load, so the
    // module is re-imported with HOME pointing at the sandbox. This is the end
    // the defect actually lived at: the daemon's getEnvVar against the CLI's
    // parseEnvFile, on one file on disk.
    process.env["HOME"] = sandboxHome;
    vi.resetModules();
    const { getEnvVar } = await import("../src/config.js");

    const fromCli = parseEnvFile(CORPUS);
    for (const key of Object.keys(fromCli)) {
      // process.env wins in getMergedEnv, so only keys absent from the ambient
      // environment can be compared — the corpus names are synthetic, but the
      // guard keeps the test honest on any machine.
      if (process.env[key] !== undefined) continue;
      expect([key, getEnvVar(key)]).toEqual([key, fromCli[key]]);
    }

    // Positive control on the same read: the key whose two readings differed.
    expect(getEnvVar("INLINE_COMMENT")).toBe("false");
  });
});
