const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const vm = require("node:vm");

const html = fs.readFileSync("public/index.html", "utf8");
const tauriLibSource = fs.readFileSync("src-tauri/src/lib.rs", "utf8");
const firstPaintSignalSource = fs.readFileSync(
  "src/app/root/useFirstPaintSignal.ts",
  "utf8"
);
const scriptMatch = html.match(
  /<script nonce="orgii-codemirror-style">\s*\/\/ -+\s*\/\/ Splash hard-timeout watchdog[\s\S]*?\(function \(\) \{([\s\S]*?)\}\)\(\);\s*<\/script>/
);

function evaluateWatchdogMs({ protocol, hostname }) {
  assert.ok(scriptMatch, "startup watchdog script should be present");

  let timeoutMs;
  const context = {
    console: {
      info: () => {},
      warn: () => {},
    },
    document: {
      documentElement: {},
      getElementById: () => null,
    },
    performance: {
      now: () => 100,
    },
    setTimeout: (_callback, ms) => {
      timeoutMs = ms;
      return 1;
    },
    fetch: () =>
      Promise.resolve({
        ok: true,
        status: 200,
      }),
    HTMLLinkElement: class HTMLLinkElement {},
    HTMLScriptElement: class HTMLScriptElement {},
    window: {
      addEventListener: () => {},
      location: {
        hostname,
        pathname: "/",
        protocol,
      },
    },
  };

  vm.createContext(context);
  vm.runInContext(`(function () {${scriptMatch[1]}})();`, context);

  return timeoutMs;
}

function evaluateClearedTimeoutsAfterSplashDone({ protocol, hostname }) {
  assert.ok(scriptMatch, "startup watchdog script should be present");

  let nextTimerId = 0;
  const scheduledTimers = [];
  const clearedTimers = [];
  const context = {
    console: {
      info: () => {},
      warn: () => {},
    },
    clearTimeout: (timerId) => {
      clearedTimers.push(timerId);
    },
    document: {
      documentElement: {},
      getElementById: () => null,
    },
    performance: {
      now: () => 100,
    },
    setTimeout: (_callback, ms) => {
      nextTimerId += 1;
      scheduledTimers.push({ id: nextTimerId, ms });
      return nextTimerId;
    },
    fetch: () =>
      Promise.resolve({
        ok: true,
        status: 200,
      }),
    HTMLLinkElement: class HTMLLinkElement {},
    HTMLScriptElement: class HTMLScriptElement {},
    window: {
      addEventListener: () => {},
      location: {
        hostname,
        pathname: "/",
        protocol,
      },
    },
  };

  vm.createContext(context);
  vm.runInContext(`(function () {${scriptMatch[1]}})();`, context);
  context.window.__ORGII_SPLASH_DONE__();

  return { scheduledTimers, clearedTimers };
}

test("startup watchdog gives localhost dev server more time", () => {
  assert.equal(
    evaluateWatchdogMs({ protocol: "http:", hostname: "127.0.0.1" }),
    60000
  );
  assert.equal(
    evaluateWatchdogMs({ protocol: "http:", hostname: "localhost" }),
    60000
  );
});

test("startup watchdog keeps packaged/static startup timeout short", () => {
  assert.equal(
    evaluateWatchdogMs({ protocol: "tauri:", hostname: "localhost" }),
    20000
  );
  assert.equal(
    evaluateWatchdogMs({ protocol: "https:", hostname: "example.test" }),
    20000
  );
});

test("startup success cancels the watchdog and diagnostic probe timers", () => {
  const { scheduledTimers, clearedTimers } =
    evaluateClearedTimeoutsAfterSplashDone({
      protocol: "http:",
      hostname: "localhost",
    });

  assert.deepEqual(
    scheduledTimers.map((timer) => timer.ms),
    [5000, 60000]
  );
  assert.deepEqual(clearedTimers, [1, 2]);
});

test("startup success only has the watchdog timer outside local dev", () => {
  const { scheduledTimers, clearedTimers } =
    evaluateClearedTimeoutsAfterSplashDone({
      protocol: "tauri:",
      hostname: "localhost",
    });

  assert.deepEqual(
    scheduledTimers.map((timer) => timer.ms),
    [20000]
  );
  assert.deepEqual(clearedTimers, [1]);
});

test("retrying main script loader runs after the root element exists", () => {
  const retryLoaderIndex = html.indexOf("retryMainScriptLoad");
  const rootIndex = html.indexOf('<div id="root"></div>');

  assert.notEqual(retryLoaderIndex, -1);
  assert.notEqual(rootIndex, -1);
  assert.ok(
    rootIndex < retryLoaderIndex,
    "retrying loader should run after #root is parsed"
  );
  const loaderSource = html.slice(retryLoaderIndex);
  assert.match(loaderSource, /orgii_startup_attempt=/);
  assert.doesNotMatch(loaderSource, /script\.textContent\s*=/);
});

test("automatic last-window exit is only prevented on macOS or release builds", () => {
  const exitRequestedArm = tauriLibSource.match(
    /tauri::RunEvent::ExitRequested[\s\S]*?=> \{([\s\S]*?)\n\s*\}\n\s*_ =>/
  );

  assert.ok(exitRequestedArm, "ExitRequested handler should be present");
  assert.match(
    exitRequestedArm[1],
    /#\[cfg\(any\(target_os = "macos", not\(debug_assertions\)\)\)\][\s\S]*_?api\.prevent_exit\(\);/
  );
  assert.match(
    exitRequestedArm[1],
    /code\.is_some\(\)[\s\S]*cfg!\(all\(debug_assertions, not\(target_os = "macos"\)\)\)/
  );
});

test("first-paint startup logging is gated behind dev startup debug", () => {
  assert.match(
    tauriLibSource,
    /if dev_startup_debug_enabled\(\) \{\s*app\.listen\("orgii-startup-first-paint"/
  );
});

test("frontend first-paint metric emit is gated to local dev", () => {
  assert.match(firstPaintSignalSource, /function isLocalDevOrigin\(\)/);
  assert.match(
    firstPaintSignalSource,
    /if \(!isLocalDevOrigin\(\)\) \{\s*return;\s*\}/
  );
});
