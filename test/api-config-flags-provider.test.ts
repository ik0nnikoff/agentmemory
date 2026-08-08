import { describe, it, expect, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerApiTriggers } from "../src/triggers/api.js";

// `GET /agentmemory/config/flags` used to answer with the KIND of provider only
// (`llm` / `noop`), which every keyed provider and codex alike report. That is
// not enough for `agentmemory codex status`, whose whole point is the split
// between the flag in ~/.agentmemory/.env and the provider the RUNNING daemon
// actually built — the daemon memoizes that file at boot (`src/config.ts:36-45`),
// so the two really can disagree.
//
// The name is read off the live provider instance and the `resilient(...)`
// decorator is peeled off; `ResilientProvider` wraps every provider
// (`src/providers/index.ts:68-69`), so an un-peeled answer would never equal a
// provider name at all.

const SECRET = "flags-test-secret";

function mockSdk() {
  const fns = new Map<string, Function>();
  return {
    registerFunction: (id: string, h: Function) => fns.set(id, h),
    registerTrigger: () => {},
    _fns: fns,
  };
}

function mockKV() {
  return {
    get: async () => null,
    set: async <T>(_s: string, _k: string, d: T) => d,
    delete: async () => {},
    update: async () => {},
    list: async () => [],
  };
}

async function configFlags(
  provider?: unknown,
): Promise<Record<string, unknown>> {
  const sdk = mockSdk();
  registerApiTriggers(sdk as never, mockKV() as never, SECRET, undefined, provider as never);
  const handler = sdk._fns.get("api::config-flags")!;
  const res = (await handler({ headers: { authorization: `Bearer ${SECRET}` } })) as {
    status_code: number;
    body: Record<string, unknown>;
  };
  expect(res.status_code).toBe(200);
  return res.body;
}

describe("api::config-flags — llmProvider", () => {
  it("names the provider the process is running, without the resilience wrapper", async () => {
    const body = await configFlags({ name: "resilient(codex)" });

    expect(body["llmProvider"]).toBe("codex");
    // The kind stays where it was: the new field is next to it, not instead of
    // it — the dashboard reads `provider` and would break on a rename.
    expect(body["provider"]).toBeDefined();
    expect(body["provider"]).not.toBe("codex");
  });

  it("keeps the composition of a fallback chain, which IS its identity", async () => {
    const body = await configFlags({ name: "resilient(fallback(codex -> anthropic))" });

    expect(body["llmProvider"]).toBe("fallback(codex -> anthropic)");
  });

  it("answers `unknown` rather than omitting the field when no provider was handed in", async () => {
    const body = await configFlags(undefined);

    // Present-but-unknown and absent are DIFFERENT answers to the CLI: absent
    // means "this daemon predates the field", which it must not claim about a
    // daemon that does carry it.
    expect(Object.prototype.hasOwnProperty.call(body, "llmProvider")).toBe(true);
    expect(body["llmProvider"]).toBe("unknown");
  });

  it("passes an unwrapped provider name through unchanged", async () => {
    const body = await configFlags({ name: "noop" });

    expect(body["llmProvider"]).toBe("noop");
  });
});
