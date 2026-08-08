import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";

import { resolveCodexBin } from "../src/cli/codex-bin.js";

describe("cli codex-bin", () => {
  it("resolves the Codex CLI through the module resolver", () => {
    const result = resolveCodexBin();

    expect(result.ok).toBe(true);
    const path = (result as { path: string }).path;
    expect(path.endsWith("codex.js")).toBe(true);
    expect(path).toContain("@openai/codex");
    expect(existsSync(path)).toBe(true);
  });

  it("explains the packaging instead of leaking a MODULE_NOT_FOUND trace", () => {
    const result = resolveCodexBin({
      resolve: () => {
        const err = new Error(
          "Cannot find module '@openai/codex/bin/codex.js'\nRequire stack:\n- /somewhere/deep/node_modules/x.js",
        ) as NodeJS.ErrnoException;
        err.code = "MODULE_NOT_FOUND";
        throw err;
      },
    });

    expect(result.ok).toBe(false);
    const reason = (result as { reason: string }).reason;
    expect(reason).toContain("@openai/codex-sdk");
    expect(reason).toContain("optionalDependencies");
    expect(reason).not.toContain("MODULE_NOT_FOUND");
    expect(reason).not.toContain("Require stack");
    expect(reason).not.toContain("Cannot find module");
  });

  it("never looks the binary up through PATH", () => {
    // D-18: `command -v` / `which` / `npm root -g` answer with whatever
    // installation sits first in PATH, which is a different copy than the one
    // this process loads.
    const source = readFileSync(new URL("../src/cli/codex-bin.ts", import.meta.url), "utf-8");
    // Comment lines name those commands on purpose (they document the ban), so
    // the grep runs on code lines only.
    const code = source
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
      .join("\n");

    expect(code).toContain("createRequire"); // positive control on the same slice
    expect(code).not.toMatch(/spawnSync\(|execSync\(|command -v|which |npm root/);
  });
});
