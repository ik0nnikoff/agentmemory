import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { codexLoginStatus } from "../src/cli/codex-session.js";

// A fake `codex` binary, never the real one: no `codex login`, no network, no
// reading of the operator's ~/.codex.
let sandbox: string;

function fakeBin(name: string, body: string): string {
  const path = join(sandbox, `${name}.cjs`);
  writeFileSync(path, body, { mode: 0o700 });
  return path;
}

describe("cli codex-session", () => {
  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "agentmemory-codex-session-"));
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("reads exit code 0 as a live session", () => {
    const bin = fakeBin("exit0", "process.exit(0);\n");

    expect(codexLoginStatus({ bin })).toEqual({ state: "logged-in" });
  });

  it("reads exit code 1 as no session", () => {
    const bin = fakeBin("exit1", "process.exit(1);\n");

    expect(codexLoginStatus({ bin })).toEqual({ state: "logged-out" });
  });

  it("treats any other exit code as an error, not as an answer", () => {
    const bin = fakeBin("exit2", "process.exit(2);\n");

    const result = codexLoginStatus({ bin });

    expect(result.state).toBe("error");
    expect((result as { reason: string }).reason).toContain("2");
  });

  it("times out instead of hanging", () => {
    const bin = fakeBin("hang", "setTimeout(() => {}, 60_000);\n");

    const result = codexLoginStatus({ bin, timeoutMs: 300 });

    expect(result.state).toBe("error");
    expect((result as { reason: string }).reason).toContain("timed out");
  });

  it("calls the binary as `node <bin> login status` and ignores what it prints", () => {
    const argvLog = join(sandbox, "argv.json");
    const bin = fakeBin(
      "record-argv",
      [
        'const fs = require("node:fs");',
        `fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));`,
        // Whatever a real `login status` prints (an account e-mail, for
        // instance) must never reach us: stdio is "ignore".
        'process.stdout.write("Logged in using ChatGPT as someone@example.com\\n");',
        'process.stderr.write("noise\\n");',
        "process.exit(0);",
      ].join("\n"),
    );

    const result = codexLoginStatus({ bin });

    expect(result).toEqual({ state: "logged-in" });
    expect(JSON.parse(readFileSync(argvLog, "utf-8"))).toEqual(["login", "status"]);
  });
});
