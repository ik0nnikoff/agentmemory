import { defineConfig, defaultExclude } from "vitest/config";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(fileURLToPath(import.meta.url));
const fakeHome = resolve(rootDir, "test/fixtures/fake-home");

export default defineConfig({
  test: {
    env: {
      HOME: fakeHome,
      USERPROFILE: fakeHome,
    },
    exclude:
      process.env.VITEST_INCLUDE_INTEGRATION === "1"
        ? defaultExclude
        : [...defaultExclude, "test/integration.test.ts"],
  },
});
