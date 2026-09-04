import path from "path";
import { defineConfig } from "vitest/config";

const repoRoot = path.resolve(__dirname, "..");

// Pin the suite's timezone process-wide, before any worker starts and before
// anything formats a Date.
//
// Two suites (`util/time/__tests__/formatRelativeTime`, `modules/shared/
// dataSource/usageTrendLabels`) assert on a NEGATIVE-offset zone so that a
// UTC-vs-local bug is actually visible; on a UTC runner it is not. They used to
// pin it themselves with a top-level `process.env.TZ = ...`, which only worked
// because the `forks` pool gave every file its own process. Under `threads`
// that assignment is a silent no-op — V8 caches the zone per PROCESS and
// workers share it — so those tests would keep passing while measuring the
// machine's own zone. Pinning here keeps them honest and makes every other
// date-formatting test independent of the developer's local zone.
process.env.TZ = "America/Los_Angeles";

export default defineConfig({
  root: repoRoot,
  resolve: {
    alias: {
      "@src": path.resolve(repoRoot, "src"),
      "@": repoRoot,
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    globals: true,
    setupFiles: ["src/test/vitest.setup.ts"],
    // Worker threads, not child processes, and capped at 4.
    //
    // The default `forks` pool spawns one full Node process per worker
    // (cores - 1, so ~9 on a 10-core machine). Measured on this suite (1314
    // files / 10332 tests):
    //
    //   forks,   ~9 workers  ->  203 s, 2.28 GB peak, 12 processes
    //   forks,    4 workers  ->  420 s, 1.56 GB peak,  7 processes
    //   threads,  4 workers  ->  219 s, 1.06 GB peak,  3 processes
    //
    // Threads share one heap, so bounding them cuts peak memory by more than
    // half at the same wall time, whereas bounding forks only trades memory
    // for a 2x slowdown. `isolate` stays on (the default), so each file still
    // gets a fresh module registry — which is what the atom-graph suites below
    // actually depend on. What threads do NOT isolate is process-global state;
    // see the TZ note at the top of this file before adding a test that
    // mutates `process.env` and expects other files not to see it.
    //
    // The cap is a memory ceiling, not a tuning knob: it keeps a full-suite run
    // affordable next to a dev server and a typecheck on a 16 GB machine.
    pool: "threads",
    poolOptions: {
      threads: { minThreads: 1, maxThreads: 4 },
    },
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
