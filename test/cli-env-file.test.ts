import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { setEnvKeys } from "../src/cli/env-file.js";

// Everything here happens inside a fresh mkdtemp directory. The operator's real
// ~/.agentmemory/.env (23 provider keys) is never opened by this suite, not
// even for reading.
let sandbox: string;
let envPath: string;

function backups(): string[] {
  return readdirSync(sandbox).filter((name) => name.includes(".bak-"));
}

function leftovers(): string[] {
  return readdirSync(sandbox).filter((name) => name.includes(".tmp-"));
}

describe("cli env-file setEnvKeys", () => {
  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "agentmemory-env-file-"));
    envPath = join(sandbox, ".env");
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("appends a missing key and leaves every other byte of the file alone", () => {
    const before = [
      "# agentmemory environment",
      "",
      "OPENAI_API_KEY=sk-not-a-real-key",
      "# AGENTMEMORY_CODEX_MODEL=commented-sample",
      "",
      "ANTHROPIC_API_KEY=also-not-real",
      "",
    ].join("\n");
    writeFileSync(envPath, before, { mode: 0o600 });

    const result = setEnvKeys(envPath, { AGENTMEMORY_CODEX: "true" });

    expect(result).toMatchObject({ ok: true, changed: true, created: false, duplicates: 0 });
    const after = readFileSync(envPath, "utf-8");
    expect(after).toBe(`${before}AGENTMEMORY_CODEX=true\n`);
    expect(leftovers()).toEqual([]);
  });

  it("adds the newline itself when the file does not end with one", () => {
    writeFileSync(envPath, "OPENAI_API_KEY=sk-not-a-real-key", { mode: 0o600 });

    setEnvKeys(envPath, { AGENTMEMORY_CODEX: "true" });

    expect(readFileSync(envPath, "utf-8")).toBe(
      "OPENAI_API_KEY=sk-not-a-real-key\nAGENTMEMORY_CODEX=true\n",
    );
  });

  it("replaces an existing value in place without growing the file by a line", () => {
    const before = ["A_KEY=one", "AGENTMEMORY_CODEX=false", "B_KEY=two", ""].join("\n");
    writeFileSync(envPath, before, { mode: 0o600 });

    const result = setEnvKeys(envPath, { AGENTMEMORY_CODEX: "true" });

    expect(result).toMatchObject({ ok: true, changed: true, duplicates: 0 });
    const after = readFileSync(envPath, "utf-8");
    expect(after).toBe(["A_KEY=one", "AGENTMEMORY_CODEX=true", "B_KEY=two", ""].join("\n"));
    expect(after.split("\n").length).toBe(before.split("\n").length);
  });

  it("does not treat a commented-out line as an occurrence of the key", () => {
    const before = ["# AGENTMEMORY_CODEX=true", "#AGENTMEMORY_CODEX=true", ""].join("\n");
    writeFileSync(envPath, before, { mode: 0o600 });

    setEnvKeys(envPath, { AGENTMEMORY_CODEX: "false" });

    const after = readFileSync(envPath, "utf-8");
    expect(after).toBe(`${before}AGENTMEMORY_CODEX=false\n`);
    // The two samples survive untouched.
    expect(after.split("\n").filter((line) => line.startsWith("#")).length).toBe(2);
  });

  it("rewrites every un-commented occurrence and reports how many there were", () => {
    writeFileSync(
      envPath,
      ["AGENTMEMORY_CODEX=false", "OTHER=x", "AGENTMEMORY_CODEX=false", ""].join("\n"),
      { mode: 0o600 },
    );

    const result = setEnvKeys(envPath, { AGENTMEMORY_CODEX: "true" });

    expect(result).toMatchObject({ ok: true, changed: true, duplicates: 2 });
    expect(readFileSync(envPath, "utf-8")).toBe(
      ["AGENTMEMORY_CODEX=true", "OTHER=x", "AGENTMEMORY_CODEX=true", ""].join("\n"),
    );
  });

  it("is idempotent: a second call writes nothing, backs up nothing and moves no mtime", () => {
    writeFileSync(envPath, "OTHER=x\n", { mode: 0o600 });
    const first = setEnvKeys(envPath, { AGENTMEMORY_CODEX: "true" });
    expect(first).toMatchObject({ ok: true, changed: true });
    const contentAfterFirst = readFileSync(envPath, "utf-8");
    const statAfterFirst = statSync(envPath);
    const backupsAfterFirst = backups().length;

    const second = setEnvKeys(envPath, { AGENTMEMORY_CODEX: "true" });

    expect(second).toEqual({ ok: true, changed: false });
    expect(readFileSync(envPath, "utf-8")).toBe(contentAfterFirst);
    expect(statSync(envPath).mtimeMs).toBe(statAfterFirst.mtimeMs);
    expect(backups().length).toBe(backupsAfterFirst);
  });

  it("treats a quoted value as already set", () => {
    const before = 'AGENTMEMORY_CODEX="true"\n';
    writeFileSync(envPath, before, { mode: 0o600 });

    expect(setEnvKeys(envPath, { AGENTMEMORY_CODEX: "true" })).toEqual({
      ok: true,
      changed: false,
    });
    expect(readFileSync(envPath, "utf-8")).toBe(before);
  });

  it("keeps an inline comment when it rewrites the value", () => {
    writeFileSync(envPath, "AGENTMEMORY_CODEX=false  # set by hand\n", { mode: 0o600 });

    setEnvKeys(envPath, { AGENTMEMORY_CODEX: "true" });

    expect(readFileSync(envPath, "utf-8")).toBe("AGENTMEMORY_CODEX=true  # set by hand\n");
  });

  it("writes several keys in one pass, one backup, one write", () => {
    writeFileSync(envPath, "AGENTMEMORY_CODEX=false\n", { mode: 0o600 });

    const result = setEnvKeys(envPath, {
      AGENTMEMORY_CODEX: "true",
      OPENAI_API_KEY_FOR_LLM: "false",
    });

    expect(result).toMatchObject({ ok: true, changed: true });
    expect(readFileSync(envPath, "utf-8")).toBe(
      "AGENTMEMORY_CODEX=true\nOPENAI_API_KEY_FOR_LLM=false\n",
    );
    expect(backups().length).toBe(1);
  });

  it("keeps the mode of an existing file and gives the backup the same mode", () => {
    writeFileSync(envPath, "OTHER=x\n", { mode: 0o600 });
    chmodSync(envPath, 0o640);

    const result = setEnvKeys(envPath, { AGENTMEMORY_CODEX: "true" });

    expect(result.ok).toBe(true);
    expect(statSync(envPath).mode & 0o777).toBe(0o640);
    const backupNames = backups();
    expect(backupNames.length).toBe(1);
    const backupPath = join(sandbox, backupNames[0] as string);
    expect(statSync(backupPath).mode & 0o777).toBe(0o640);
    // The backup holds the PREVIOUS content.
    expect(readFileSync(backupPath, "utf-8")).toBe("OTHER=x\n");
    expect((result as { backupPath: string }).backupPath).toBe(backupPath);
  });

  it("creates a missing file with mode 0600 and does not copy .env.example", () => {
    expect(existsSync(envPath)).toBe(false);

    const result = setEnvKeys(envPath, { AGENTMEMORY_CODEX: "true" });

    expect(result).toMatchObject({ ok: true, changed: true, created: true, backupPath: "" });
    expect(readFileSync(envPath, "utf-8")).toBe("AGENTMEMORY_CODEX=true\n");
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    expect(backups()).toEqual([]);
    expect(leftovers()).toEqual([]);
  });

  it("preserves CRLF line endings of the lines it rewrites", () => {
    writeFileSync(envPath, "OTHER=x\r\nAGENTMEMORY_CODEX=false\r\n", { mode: 0o600 });

    setEnvKeys(envPath, { AGENTMEMORY_CODEX: "true" });

    expect(readFileSync(envPath, "utf-8")).toBe("OTHER=x\r\nAGENTMEMORY_CODEX=true\r\n");
  });

  it("refuses an invalid key name without touching the file", () => {
    writeFileSync(envPath, "OTHER=x\n", { mode: 0o600 });

    const result = setEnvKeys(envPath, { "BAD KEY=x\nEVIL": "true" });

    expect(result.ok).toBe(false);
    expect(readFileSync(envPath, "utf-8")).toBe("OTHER=x\n");
    expect(backups()).toEqual([]);
  });

  it("reports a failure by key name and path only, never by content", () => {
    const secret = "sk-super-secret-value";
    writeFileSync(envPath, `OPENAI_API_KEY=${secret}\n`, { mode: 0o600 });
    // A directory where the file is expected: the write cannot succeed.
    const unwritable = join(sandbox, "nested");
    const result = setEnvKeys(join(unwritable, ".env"), { AGENTMEMORY_CODEX: "true" });

    expect(result.ok).toBe(false);
    const reason = (result as { reason: string }).reason;
    expect(reason).toContain("AGENTMEMORY_CODEX");
    expect(reason).not.toContain(secret);
  });

  it("does nothing when asked for no keys at all", () => {
    writeFileSync(envPath, "OTHER=x\n", { mode: 0o600 });

    expect(setEnvKeys(envPath, {})).toEqual({ ok: true, changed: false });
    expect(backups()).toEqual([]);
  });
});
