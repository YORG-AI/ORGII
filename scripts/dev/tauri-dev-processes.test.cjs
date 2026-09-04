const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const {
  createDevUrl,
  createFrontendScriptName,
  createTauriArgs,
  formatElapsedMs,
  formatStartupMetricsTsv,
  isBenignWebKitGtkInternalErrorLine,
  isInitialWebpackReadyLine,
  waitForDevServerAsset,
} = require("./tauri-dev-processes.cjs");

const tauriDevSource = fs.readFileSync("scripts/dev/tauri.js", "utf8");
const tauriLauncherSource = fs.readFileSync(
  "scripts/dev/tauri-launcher.cjs",
  "utf8"
);
const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));

test("frontend script name defaults to rspack everywhere but Windows", () => {
  assert.equal(
    createFrontendScriptName({ platform: "darwin" }),
    "dev:frontend:rspack"
  );
  assert.equal(
    createFrontendScriptName({ platform: "linux" }),
    "dev:frontend:rspack"
  );
  assert.equal(createFrontendScriptName({ platform: "win32" }), "dev:frontend");
  // Explicit overrides beat the platform default in both directions.
  assert.equal(
    createFrontendScriptName({ rspack: true, platform: "win32" }),
    "dev:frontend:rspack"
  );
  assert.equal(
    createFrontendScriptName({ rspack: false, platform: "darwin" }),
    "dev:frontend"
  );
  // Light dev wins: it has no rspack equivalent yet.
  assert.equal(
    createFrontendScriptName({ lightDev: true, rspack: true }),
    "dev:frontend:light"
  );
  // The npm scripts and launcher flags the names resolve to must exist.
  assert.ok(packageJson.scripts["dev:frontend:rspack"]);
  assert.ok(packageJson.scripts["tauri:dev:webpack"]);
  assert.ok(tauriLauncherSource.includes('args.includes("--rspack")'));
  assert.ok(tauriLauncherSource.includes('args.includes("--webpack")'));
});

test("recognizes only the initial successful webpack compile as ready", () => {
  assert.equal(
    isInitialWebpackReadyLine("WEBPACK_STATUS:done_initial 1234ms"),
    true
  );
  assert.equal(isInitialWebpackReadyLine("WEBPACK_STATUS:done 150ms"), false);
  assert.equal(
    isInitialWebpackReadyLine("WEBPACK_STATUS:done_warnings 150ms"),
    false
  );
  assert.equal(isInitialWebpackReadyLine("WEBPACK_STATUS:error"), false);
});

test("tauri args disable beforeDevCommand after wrapper starts webpack", () => {
  assert.deepEqual(createTauriArgs({ features: [], lightDev: false }), [
    "dev",
    "--config",
    '{"build":{"beforeDevCommand":""}}',
  ]);
});

test("tauri args preserve features and devUrl override", () => {
  assert.deepEqual(
    createTauriArgs({
      features: ["webdriver"],
      lightDev: true,
      devUrl: "http://127.0.0.1:1998",
    }),
    [
      "dev",
      "--features",
      "webdriver",
      "--config",
      '{"build":{"beforeDevCommand":"","devUrl":"http://127.0.0.1:1998"}}',
    ]
  );
});

test("dev wrapper does not pass terminal stdin to child processes", () => {
  const ignoredStdinSpawns = tauriDevSource.match(
    /stdio:\s*\["ignore",\s*"pipe",\s*"pipe"\]/g
  );
  assert.equal(ignoredStdinSpawns?.length, 2);
});

test("tauri dev npm scripts use a cross-platform launcher", () => {
  assert.equal(
    packageJson.scripts["tauri:dev"],
    "node scripts/dev/tauri-launcher.cjs"
  );
  assert.equal(
    packageJson.scripts["tauri:dev:light"],
    "node scripts/dev/tauri-launcher.cjs --light"
  );
  assert.doesNotMatch(packageJson.scripts["tauri:dev"], /setsid|\/dev\/null/);
  assert.doesNotMatch(
    packageJson.scripts["tauri:dev:light"],
    /setsid|\/dev\/null/
  );
});

test("tauri dev launcher detaches Unix stdin without requiring setsid", () => {
  assert.match(tauriLauncherSource, /detached:\s*process\.platform !== "win32"/);
  assert.match(tauriLauncherSource, /stdio:\s*\["ignore",\s*"inherit",\s*"inherit"\]/);
  assert.match(tauriLauncherSource, /env\.ORGII_LIGHT_DEV = "true"/);
  assert.match(tauriLauncherSource, /SIGINT:\s*130/);
  assert.match(tauriLauncherSource, /SIGTERM:\s*143/);
  assert.doesNotMatch(tauriLauncherSource, /setsid/);
});

test("dev URL defaults to the same localhost origin as Tauri config", () => {
  assert.equal(createDevUrl({}), "http://localhost:1998");
  assert.equal(
    createDevUrl({ WEBPACK_DEV_SERVER_PORT: "3000" }),
    "http://localhost:3000"
  );
});

test("waits for the dev server asset after webpack reports ready", async () => {
  const attempts = [];
  const delays = [];

  await waitForDevServerAsset("http://localhost:1998/main.js", {
    timeoutMs: 1000,
    retryDelayMs: 25,
    fetchAsset: async (url) => {
      attempts.push(url);
      return attempts.length >= 3;
    },
    delay: async (ms) => {
      delays.push(ms);
    },
  });

  assert.deepEqual(attempts, [
    "http://localhost:1998/main.js",
    "http://localhost:1998/main.js",
    "http://localhost:1998/main.js",
  ]);
  assert.deepEqual(delays, [25, 25]);
});

test("classifies known WebKitGTK internal loader errors as suppressible", () => {
  assert.equal(
    isBenignWebKitGtkInternalErrorLine(
      "ERROR: WebKit encountered an internal error. This is a WebKit bug."
    ),
    true
  );
  assert.equal(
    isBenignWebKitGtkInternalErrorLine(
      "./Source/WebKit/WebProcess/Network/WebLoaderStrategy.cpp(618) : void WebKit::WebLoaderStrategy::internallyFailedLoadTimerFired()"
    ),
    true
  );
  assert.equal(
    isBenignWebKitGtkInternalErrorLine("ERROR: failed to load main.js"),
    false
  );
});

test("formats startup elapsed durations for milestone logs", () => {
  assert.equal(formatElapsedMs(0), "0.00s");
  assert.equal(formatElapsedMs(325), "0.33s");
  assert.equal(formatElapsedMs(12_345), "12.35s");
});

test("formats startup metrics as stable TSV", () => {
  assert.equal(
    formatStartupMetricsTsv({
      startedAtIso: "2026-06-24T10:00:00.000Z",
      pid: 123,
      lightDev: true,
      milestones: {
        webpackStart: 1,
        webpackDone: 2000,
        mainJsReady: 2100,
        rustStart: 2,
        rustDone: 10_000,
        tauriStart: 10_100,
        appLaunched: 11_000,
        backendReady: 11_500,
      },
    }),
    "2026-06-24T10:00:00.000Z\t123\ttrue\t1\t2000\t2100\t2\t10000\t10100\t11000\t11500"
  );
});
