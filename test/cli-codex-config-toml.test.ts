import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readCodexToml } from "../src/cli/codex-config-toml.js";

// Every case runs against a config.toml written into a temp directory. The
// operator's own ~/.codex is never read here, and nothing in this suite writes
// outside the sandbox.
//
// Model and effort names are invented on purpose: this repository holds zero
// real model names, in the source and in the assertions alike.
let sandbox: string;

function writeToml(text: string): string {
  writeFileSync(join(sandbox, "config.toml"), text);
  return sandbox;
}

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "codex-toml-test-"));
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("readCodexToml", () => {
  it("reads quoted values", () => {
    const home = writeToml(
      ['model = "alpha-one"', 'model_reasoning_effort = "ultra"', ""].join("\n"),
    );

    expect(readCodexToml(home)).toEqual({ model: "alpha-one", reasoningEffort: "ultra" });
  });

  it("reads bare, unquoted values", () => {
    const home = writeToml(["model = alpha-two", "model_reasoning_effort = max", ""].join("\n"));

    expect(readCodexToml(home)).toEqual({ model: "alpha-two", reasoningEffort: "max" });
  });

  it("ignores a key that sits after the first [section] header", () => {
    // The distinguishing half: the same key name, twice, once above and once
    // below the header. A parser that ignored sections would answer
    // "beta-profile" here and pass an existence-only assertion just as well.
    const home = writeToml(
      [
        'model = "alpha-three"',
        "",
        "[profiles.work]",
        'model = "beta-profile"',
        'model_reasoning_effort = "high"',
        "",
      ].join("\n"),
    );

    expect(readCodexToml(home)).toEqual({ model: "alpha-three" });
  });

  it("takes nothing at all from a file that starts with a section header", () => {
    const home = writeToml(['[profiles.work]', 'model = "beta-profile"', ""].join("\n"));

    expect(readCodexToml(home)).toEqual({});
  });

  it("answers with an empty object when the file does not exist", () => {
    // No file was written into this sandbox at all.
    expect(readCodexToml(sandbox)).toEqual({});
    expect(readCodexToml(join(sandbox, "no-such-directory"))).toEqual({});
  });

  it("drops comments and blank lines instead of reading them as values", () => {
    const home = writeToml(
      [
        "# the operator's own note",
        "",
        'model = "alpha-four"   # inline note',
        "",
      ].join("\n"),
    );

    expect(readCodexToml(home)).toEqual({ model: "alpha-four" });
  });
});
