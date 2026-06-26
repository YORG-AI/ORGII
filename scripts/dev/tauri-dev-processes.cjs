const http = require("node:http");
const https = require("node:https");

function createTauriArgs({ features = [], devUrl } = {}) {
  const args = ["dev"];
  if (features.length > 0) {
    args.push("--features", features.join(","));
  }

  const buildConfig = {
    beforeDevCommand: "",
  };
  if (devUrl) {
    buildConfig.devUrl = devUrl;
  }

  args.push(
    "--config",
    JSON.stringify({
      build: buildConfig,
    })
  );

  return args;
}

function createFrontendScriptName({ lightDev = false } = {}) {
  return lightDev ? "dev:frontend:light" : "dev:frontend";
}

function createDevUrl(env = process.env) {
  const port = env.WEBPACK_DEV_SERVER_PORT || env.PORT || "1998";
  return `http://localhost:${port}`;
}

function stripAnsi(line) {
  return String(line)
    .replace(/\x1b\[[0-9;]*[mGKJH]/g, "")
    .trim();
}

function isInitialWebpackReadyLine(line) {
  return stripAnsi(line).startsWith("WEBPACK_STATUS:done_initial");
}

function isBenignWebKitGtkInternalErrorLine(line) {
  const clean = stripAnsi(line);
  return (
    clean ===
      "ERROR: WebKit encountered an internal error. This is a WebKit bug." ||
    clean.includes("WebLoaderStrategy.cpp(618)") ||
    clean.includes("internallyFailedLoadTimerFired()")
  );
}

function formatElapsedMs(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

const STARTUP_METRIC_KEYS = [
  "webpackStart",
  "webpackDone",
  "mainJsReady",
  "rustStart",
  "rustDone",
  "tauriStart",
  "appLaunched",
  "backendReady",
];

function formatStartupMetricsTsv({ startedAtIso, pid, lightDev, milestones }) {
  return [
    startedAtIso,
    pid,
    lightDev,
    ...STARTUP_METRIC_KEYS.map((key) => milestones[key] ?? ""),
  ].join("\t");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchHttpAsset(url) {
  return new Promise((resolve) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === "https:" ? https : http;
    const request = client.get(
      parsedUrl,
      {
        headers: {
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
        },
        timeout: 2000,
      },
      (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      }
    );

    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => {
      resolve(false);
    });
  });
}

async function waitForDevServerAsset(
  url,
  {
    timeoutMs = 15000,
    retryDelayMs = 100,
    fetchAsset = fetchHttpAsset,
    delay: wait = delay,
  } = {}
) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() <= deadline) {
    try {
      if (await fetchAsset(url)) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await wait(retryDelayMs);
  }

  const suffix = lastError && lastError.message ? `: ${lastError.message}` : "";
  throw new Error(`Dev server asset did not become ready: ${url}${suffix}`);
}

module.exports = {
  createDevUrl,
  createFrontendScriptName,
  createTauriArgs,
  formatElapsedMs,
  formatStartupMetricsTsv,
  isBenignWebKitGtkInternalErrorLine,
  isInitialWebpackReadyLine,
  stripAnsi,
  waitForDevServerAsset,
};
