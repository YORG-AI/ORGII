import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@src": path.resolve(__dirname, "src"),
      "@": path.resolve(__dirname),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    globals: true,
    setupFiles: ["src/test/vitest.setup.ts"],
    // Several state-integration suites intentionally reset and dynamically
    // reload large atom graphs. On Windows, full-suite worker contention can
    // push those imports just beyond Vitest's 5 second default even though the
    // same assertions complete quickly in isolation.
    testTimeout: 15_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "html", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.d.ts", "src/**/*.tsx"],
    },
  },
});
