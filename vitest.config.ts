import { defineConfig, defaultExclude } from "vitest/config";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(fileURLToPath(import.meta.url));
const fakeHome = resolve(rootDir, "test/fixtures/fake-home");

// Suites that cost something real and are therefore opt-in, each behind the
// switch that already gates the thing it costs. They are EXCLUDED rather than
// skipped: a skipped suite still moves the "N skipped" line every gate of this
// program compares against a baseline.
const optionalSuites = [
  ...(process.env.VITEST_INCLUDE_INTEGRATION === "1"
    ? []
    : ["test/integration.test.ts"]),
  // Two real turns on the operator's ChatGPT subscription plus two real
  // `codex exec` children. Same switch the suite itself reads.
  ...(process.env.AGENTMEMORY_CODEX_LIVE === "1"
    ? []
    : ["test/codex-provider-live.test.ts"]),
];

export default defineConfig({
  test: {
    env: {
      HOME: fakeHome,
      USERPROFILE: fakeHome,
    },
    exclude: [...defaultExclude, ...optionalSuites],
  },
});
