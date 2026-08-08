import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listCodexModels } from "../src/cli/codex-catalog.js";

// A fake `codex app-server`: a script that answers JSON-RPC lines from a
// canned table. No network, no live Codex, no ~/.codex.
//
// The child is spawned with an allowlisted environment, so the fake cannot be
// configured through env vars — every path and every canned answer is baked
// into the script text.
let sandbox: string;

const FAKE_CODEX_HOME = "/fake/codex/home";

/** Model rows carry invented names on purpose: no real model name in this repo. */
const PAGE_ONE = {
  data: [
    {
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
    },
    {
      id: "alpha-two",
      model: "alpha-two",
      displayName: "Alpha Two",
      description: "second",
      supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "middle" }],
      defaultReasoningEffort: "medium",
      isDefault: false,
      hidden: false,
    },
  ],
  nextCursor: "cursor-2",
};

const PAGE_TWO = {
  data: [
    {
      id: "beta-one",
      model: "beta-one",
      displayName: "Beta One",
      description: "third",
      supportedReasoningEfforts: [{ reasoningEffort: "xhigh", description: "very slow" }],
      defaultReasoningEffort: "xhigh",
      isDefault: false,
      hidden: false,
    },
  ],
  nextCursor: "cursor-3",
};

const PAGE_THREE = {
  data: [
    {
      id: "beta-two",
      model: "beta-two",
      displayName: "Beta Two",
      description: "fourth",
      supportedReasoningEfforts: [{ reasoningEffort: "max", description: "maximum" }],
      defaultReasoningEffort: "max",
      isDefault: false,
      hidden: false,
    },
  ],
  nextCursor: null,
};

function fakeServer(name: string, body: string): string {
  const path = join(sandbox, `${name}.cjs`);
  writeFileSync(path, body, { mode: 0o700 });
  return path;
}

/**
 * @param pages  cursor ("" for the first call) -> ModelListResponse
 * @param logPath every received request plus the child's own env key names
 */
function pagingServer(pages: Record<string, unknown>, logPath: string, name = "app-server"): string {
  return fakeServer(
    name,
    [
      'const fs = require("node:fs");',
      `const PAGES = ${JSON.stringify(pages)};`,
      `const LOG = ${JSON.stringify(logPath)};`,
      'function send(o) { process.stdout.write(JSON.stringify(o) + "\\n"); }',
      'let buffer = "";',
      'process.stdin.setEncoding("utf-8");',
      'process.stdin.on("data", (chunk) => {',
      "  buffer += chunk;",
      '  let i = buffer.indexOf("\\n");',
      "  while (i >= 0) {",
      "    const line = buffer.slice(0, i).trim();",
      "    buffer = buffer.slice(i + 1);",
      '    i = buffer.indexOf("\\n");',
      '    if (line === "") continue;',
      "    const msg = JSON.parse(line);",
      "    fs.appendFileSync(",
      "      LOG,",
      "      JSON.stringify({",
      "        method: msg.method,",
      "        params: msg.params,",
      "        envKeys: Object.keys(process.env).sort(),",
      '      }) + "\\n",',
      "    );",
      '    if (msg.method === "initialize") {',
      // A banner line that is not JSON and a notification without an id: both
      // must be skipped by the reader.
      '      process.stdout.write("codex app-server ready\\n");',
      '      send({ jsonrpc: "2.0", method: "thread/started", params: {} });',
      "      send({",
      '        jsonrpc: "2.0",',
      "        id: msg.id,",
      "        result: {",
      `          codexHome: ${JSON.stringify(FAKE_CODEX_HOME)},`,
      '          userAgent: "fake",',
      '          platformOs: "test",',
      '          platformFamily: "unix",',
      "        },",
      "      });",
      '    } else if (msg.method === "model/list") {',
      '      const cursor = (msg.params && msg.params.cursor) || "";',
      "      const page = PAGES[cursor];",
      "      if (!page) {",
      '        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: "unknown cursor" } });',
      "      } else {",
      '        send({ jsonrpc: "2.0", id: msg.id, result: page });',
      "      }",
      "    }",
      "  }",
      "});",
    ].join("\n"),
  );
}

function logEntries(logPath: string): Array<{
  method: string;
  params: Record<string, unknown>;
  envKeys: string[];
}> {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf-8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

describe("cli codex-catalog", () => {
  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "agentmemory-codex-catalog-"));
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("walks every page of model/list and keeps the order of the rows", async () => {
    const logPath = join(sandbox, "requests.log");
    const bin = pagingServer(
      { "": PAGE_ONE, "cursor-2": PAGE_TWO, "cursor-3": PAGE_THREE },
      logPath,
    );

    const result = await listCodexModels({ bin, timeoutMs: 10_000 });

    expect(result.ok).toBe(true);
    const models = (result as { models: Array<Record<string, unknown>> }).models;
    expect(models.map((m) => m["id"])).toEqual([
      "alpha-one",
      "alpha-two",
      "beta-one",
      "beta-two",
    ]);
    expect(models[0]).toMatchObject({
      displayName: "Alpha One",
      defaultReasoningEffort: "low",
      isDefault: true,
      hidden: false,
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "fast" },
        { reasoningEffort: "high", description: "slow" },
      ],
    });

    // Three model/list calls: the first without a cursor, then each nextCursor
    // handed back verbatim.
    const requests = logEntries(logPath);
    expect(requests.map((entry) => entry.method)).toEqual([
      "initialize",
      "model/list",
      "model/list",
      "model/list",
    ]);
    expect(requests.slice(1).map((entry) => entry.params["cursor"])).toEqual([
      undefined,
      "cursor-2",
      "cursor-3",
    ]);
  });

  it("takes CODEX_HOME from the initialize answer rather than computing it", async () => {
    const bin = pagingServer({ "": PAGE_THREE }, join(sandbox, "requests.log"));

    const result = await listCodexModels({ bin, timeoutMs: 10_000 });

    expect((result as { codexHome: string }).codexHome).toBe(FAKE_CODEX_HOME);
  });

  it("introduces itself with the agentmemory client name", async () => {
    const logPath = join(sandbox, "requests.log");
    const bin = pagingServer({ "": PAGE_THREE }, logPath);

    await listCodexModels({ bin, timeoutMs: 10_000 });

    const initialize = logEntries(logPath)[0];
    expect((initialize?.params["clientInfo"] as Record<string, unknown>)["name"]).toBe(
      "agentmemory",
    );
  });

  it("hands the child only the provider allowlist, not this process's keys", async () => {
    const logPath = join(sandbox, "requests.log");
    const bin = pagingServer({ "": PAGE_THREE }, logPath);
    process.env["AGENTMEMORY_TEST_FAKE_SECRET"] = "not-a-real-key";
    try {
      await listCodexModels({ bin, timeoutMs: 10_000 });
    } finally {
      delete process.env["AGENTMEMORY_TEST_FAKE_SECRET"];
    }

    const envKeys = logEntries(logPath)[0]?.envKeys ?? [];
    expect(envKeys).not.toContain("AGENTMEMORY_TEST_FAKE_SECRET");
    expect(envKeys).toContain("PATH"); // positive control: the allowlist did pass
  });

  it("stops instead of following a cursor forever", async () => {
    const logPath = join(sandbox, "requests.log");
    // Every page points at itself.
    const endless = { "": { data: [], nextCursor: "loop" }, loop: { data: [], nextCursor: "loop" } };
    const bin = pagingServer(endless, logPath);

    const result = await listCodexModels({ bin, timeoutMs: 10_000 });

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain("20 pages");
  });

  it("fails with a timeout when the server stops answering", async () => {
    const bin = fakeServer(
      "silent",
      [
        'let buffer = "";',
        'process.stdin.setEncoding("utf-8");',
        'process.stdin.on("data", (chunk) => {',
        "  buffer += chunk;",
        '  let i = buffer.indexOf("\\n");',
        "  while (i >= 0) {",
        "    const line = buffer.slice(0, i).trim();",
        "    buffer = buffer.slice(i + 1);",
        '    i = buffer.indexOf("\\n");',
        '    if (line === "") continue;',
        "    const msg = JSON.parse(line);",
        // Answers initialize, then goes quiet on model/list.
        '    if (msg.method === "initialize") {',
        '      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { codexHome: "/fake" } }) + "\\n");',
        "    }",
        "  }",
        "});",
        "setTimeout(() => {}, 60_000);",
      ].join("\n"),
    );

    const result = await listCodexModels({ bin, timeoutMs: 400 });

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain("400 ms");
  });

  it("fails when the server dies before answering", async () => {
    const bin = fakeServer("die", "process.exit(7);\n");

    const result = await listCodexModels({ bin, timeoutMs: 10_000 });

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain("exited before answering");
  });

  it("passes a JSON-RPC error of the server through as a failure", async () => {
    const logPath = join(sandbox, "requests.log");
    // No page is registered for the empty cursor, so the fake answers with a
    // JSON-RPC error object.
    const bin = pagingServer({ "cursor-2": PAGE_THREE }, logPath);

    const result = await listCodexModels({ bin, timeoutMs: 10_000 });

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toContain("unknown cursor");
  });

  it("keeps zero model names in the source of the codex CLI modules", () => {
    for (const file of [
      "codex-catalog.ts",
      "codex-bin.ts",
      "codex-session.ts",
      "codex-config-toml.ts",
    ]) {
      const source = readFileSync(new URL(`../src/cli/${file}`, import.meta.url), "utf-8");
      expect(source.length).toBeGreaterThan(0); // positive control on the same read
      expect(source).toMatch(/codex/i); // positive control: the word IS there
      expect(source).not.toMatch(/gpt-/i);
    }
  });
});
