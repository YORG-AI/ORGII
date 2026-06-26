#!/usr/bin/env node

/**
 * ORG II Tauri Dev Script
 *
 * Output layout:
 *   Normal scrolling log
 *   ─────────────────────────────────────
 *   [Rust]    Compiling objc2-app-kit v0.3.2      (or "idle")
 *   [Webpack] building (43%) 4/5 entries           (or "idle")
 */

const { spawn, execFileSync, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { tauriFeatureList } = require("../tauri/features.cjs");
const {
  applyDefaultDiagnosticsEndpoint,
} = require("../tauri/diagnostics-endpoint.cjs");
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
const readline = require("readline");

const rootDir = path.join(__dirname, "..", "..");

// ─── Terminal status bar ──────────────────────────────────────────────────────

const isTTY = process.stdout.isTTY;

const STATUS = {
  rust: "idle",
  webpack: "idle",
};

const LAST_COUNT = {
  rust: "",
  webpack: "",
};

let statusBarActive = false;
let appLaunchPrinted = false;
let serviceReadyPrinted = false;
let devStartupStartedAt = Date.now();
let startupMetrics = createStartupMetrics();

function createStartupMetrics() {
  return {
    startedAtIso: new Date().toISOString(),
    pid: process.pid,
    lightDev: process.env.ORGII_LIGHT_DEV === "true",
    milestones: {},
  };
}

const STYLE = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  logoBg: "\x1b[48;2;0;0;0m",
  logoInnerBg: "\x1b[48;2;12;12;12m",
  muted: "\x1b[38;2;150;150;150m",
  white: "\x1b[37m",
};

function paint(text, ...styles) {
  if (!isTTY) return text;
  return `${styles.join("")}${text}${STYLE.reset}`;
}

function logoLine(content) {
  return `${STYLE.logoBg}${content}${STYLE.reset}`;
}

function logoInnerLine(content) {
  return `${STYLE.logoBg} ${STYLE.logoInnerBg}${content}${STYLE.logoBg} ${STYLE.reset}`;
}

function printBanner(features) {
  if (!isTTY) {
    console.log("ORG II Tauri Dev");
    return;
  }

  const title = `${paint("ORG", STYLE.muted, STYLE.bold)} ${paint("II", STYLE.white, STYLE.bold)}`;
  const subtitle = paint("Tauri Dev", STYLE.muted);
  const lightDevLabel =
    process.env.ORGII_LIGHT_DEV === "true" ? "light dev, " : "";
  const featureLabel = features.length
    ? `${lightDevLabel}features: ${features.join(", ")}`
    : `${lightDevLabel}default desktop profile`;
  const logoText = paint(
    "   II   ",
    STYLE.white,
    STYLE.bold,
    STYLE.logoInnerBg
  );

  console.log("");
  console.log(`  ${logoLine("          ")}  ${title}`);
  console.log(`  ${logoInnerLine("        ")}  ${subtitle}`);
  console.log(
    `  ${logoInnerLine(logoText)}  ${paint(featureLabel, STYLE.dim)}`
  );
  console.log(`  ${logoInnerLine("        ")}`);
  console.log(`  ${logoLine("          ")}`);
  console.log("");
}

function writeStatusBar() {
  if (!isTTY) return;

  const cols = process.stdout.columns || 80;
  const separator = "─".repeat(cols);
  const rustLine = `\x1b[2m[Rust]   \x1b[0m ${STATUS.rust}`.slice(0, cols);
  const webpackLine = `\x1b[2m[Webpack]\x1b[0m ${STATUS.webpack}`.slice(
    0,
    cols
  );

  if (statusBarActive) {
    // Move up 3 lines (separator + rust + webpack) and redraw
    process.stdout.write("\x1b[3A\x1b[0J");
  }

  process.stdout.write(
    `\x1b[2m${separator}\x1b[0m\n${rustLine}\n${webpackLine}\n`
  );
  statusBarActive = true;
}

function printLog(line) {
  if (!isTTY) {
    process.stdout.write(line + "\n");
    return;
  }
  if (statusBarActive) {
    // Move up 3 lines, erase, print log line, then redraw status bar
    process.stdout.write("\x1b[3A\x1b[0J");
    statusBarActive = false;
  }
  process.stdout.write(line + "\n");
  writeStatusBar();
}

function recordStartupMetric(key) {
  if (key) {
    startupMetrics.milestones[key] = Date.now() - devStartupStartedAt;
  }
}

function appendStartupMetrics() {
  try {
    fs.appendFileSync(
      "/tmp/orgii-tauri-dev-startup.tsv",
      `${formatStartupMetricsTsv(startupMetrics)}\n`
    );
  } catch (_error) {
    // Metrics are best-effort diagnostics.
  }
}

function printStartupMilestone(label, key) {
  recordStartupMetric(key);
  printLog(
    `[DevStartup +${formatElapsedMs(Date.now() - devStartupStartedAt)}] ${label}`
  );
}

function setRustStatus(text) {
  STATUS.rust = text;
  writeStatusBar();
}

function setWebpackStatus(text) {
  STATUS.webpack = text;
  writeStatusBar();
}

function shouldSuppressLine(clean) {
  return (
    clean.startsWith("Info Watching ") ||
    clean.startsWith("Running DevCommand (`cargo ") ||
    clean.startsWith("Running BeforeDevCommand (`pnpm run dev:frontend`)") ||
    clean.startsWith(
      "Info `tauri` dependency has workspace inheritance enabled"
    ) ||
    clean ===
      "Info Watching /Users/laptop-h/Documents/GitHub/yorg_frontend/src-tauri for changes..." ||
    /^> orgii@/.test(clean) ||
    clean === "> node scripts/dev/webpack-server.js" ||
    clean === "webpack compiled successfully" ||
    /^webpack compiled successfully in \d+ ms$/.test(clean) ||
    clean.includes("[builtin-overrides] Loaded ") ||
    clean.includes("Started watching repository:") ||
    clean.includes("Successfully started watching repo:") ||
    clean.includes(
      "tauri_plugin_updater::updater: update endpoint did not respond with a successful status code"
    ) ||
    (process.env.ORGII_LIGHT_DEV === "true" &&
      isBenignWebKitGtkInternalErrorLine(clean)) ||
    clean.startsWith("📚 Git API:") ||
    clean.startsWith("🔍 Search API:") ||
    clean.startsWith("📄 File API:") ||
    clean.startsWith("🤖 Agent API:") ||
    clean.startsWith("🔌 WebSocket:")
  );
}

// ─── Line routing ─────────────────────────────────────────────────────────────

function routeLine(line) {
  // Strip ANSI escape sequences for matching
  const clean = line.replace(/\x1b\[[0-9;]*[mGKJH]/g, "").trim();

  if (!clean) {
    return;
  }

  if (shouldSuppressLine(clean)) {
    return;
  }

  const rebuildMatch = clean.match(
    /^Info File (.+) changed\. Rebuilding application\.\.\./
  );
  if (rebuildMatch) {
    const fileName = path.basename(rebuildMatch[1]);
    setRustStatus(`rebuilding ${fileName}...`);
    return;
  }

  if (clean.startsWith("Running `/") && clean.endsWith("/org2`")) {
    if (!appLaunchPrinted) {
      appLaunchPrinted = true;
      printStartupMilestone("Tauri app binary launched", "appLaunched");
      printLog("🖥️  Tauri app launched");
    }
    setRustStatus("app running");
    return;
  }

  if (clean.startsWith("🚀 Unified IDE server starting on")) {
    if (!serviceReadyPrinted) {
      serviceReadyPrinted = true;
      printStartupMilestone("backend HTTP server ready", "backendReady");
      appendStartupMetrics();
      printLog(clean);
    }
    return;
  }

  // Webpack structured status lines emitted by webpack-server.js
  if (clean.startsWith("WEBPACK_PROGRESS:")) {
    const rest = clean.slice("WEBPACK_PROGRESS:".length);
    const pctMatch = rest.match(/^(\d+)/);
    if (pctMatch) {
      LAST_COUNT.webpack = "100%";
      setWebpackStatus(`${pctMatch[1]}/100`);
    } else {
      setWebpackStatus(rest);
    }
    return;
  }

  if (clean.startsWith("WEBPACK_STATUS:")) {
    const code = clean.slice("WEBPACK_STATUS:".length);
    const ms = code.split(" ")[1] || "";
    const countLabel = LAST_COUNT.webpack || "";
    if (code.startsWith("done_initial")) {
      const parts = [countLabel, ms].filter(Boolean);
      setWebpackStatus(
        `\x1b[32mDone\x1b[0m${parts.length ? " " + parts.join(" | ") : ""}`
      );
    } else if (code.startsWith("done_warnings")) {
      const parts = [countLabel, ms, "warnings"].filter(Boolean);
      setWebpackStatus(`\x1b[33mDone ${parts.join(" | ")}\x1b[0m`);
    } else if (code.startsWith("done")) {
      const parts = [countLabel, ms].filter(Boolean);
      setWebpackStatus(
        `\x1b[32mDone\x1b[0m${parts.length ? " " + parts.join(" | ") : ""}`
      );
    } else if (code === "recompiling") {
      setWebpackStatus("recompiling...");
    } else if (code === "error") {
      setWebpackStatus("\x1b[31merror\x1b[0m");
    } else {
      setWebpackStatus(code);
    }
    return;
  }

  // Webpack asset count from stats output (e.g. "449 assets")
  const assetMatch = clean.match(/^(\d+)\s+assets?\b/);
  if (assetMatch) {
    LAST_COUNT.webpack = `${assetMatch[1]} assets`;
    return;
  }

  // Rust cargo output
  if (/^\s*(Compiling|Finished|error\[|warning\[|Building)\s/.test(clean)) {
    if (/^\s*Compiling\s/.test(clean)) {
      setRustStatus(clean.replace(/^\s*/, ""));
    } else if (/^\s*Finished\s/.test(clean)) {
      const timeMatch = clean.match(/in\s+([\d.]+s)/);
      const time = timeMatch ? timeMatch[1] : "";
      const parts = [LAST_COUNT.rust, time].filter(Boolean);
      recordStartupMetric("rustDone");
      setRustStatus(
        `\x1b[32mFinished\x1b[0m${parts.length ? " " + parts.join(" | ") : ""}`
      );
    } else if (/^\s*Building\s/.test(clean)) {
      const counts = clean.match(/(\d+)\/(\d+)/);
      if (counts) {
        LAST_COUNT.rust = `${counts[2]} crates`;
        setRustStatus(`Building ${counts[1]}/${counts[2]}`);
      } else {
        setRustStatus("Building...");
      }
    } else {
      printLog(line);
    }
    return;
  }

  // Everything else scrolls normally
  printLog(line);
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

function cleanupOrphanedProcesses() {
  try {
    const cleanupScript = path.join(__dirname, "cleanup-orphans.cjs");
    execFileSync(process.execPath, [cleanupScript, "--quiet"], {
      stdio: "inherit",
      cwd: rootDir,
    });
  } catch (_error) {
    // Non-fatal
  }
}

// ─── Start Tauri dev ──────────────────────────────────────────────────────────

function killDescendants(pid) {
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } catch (_err) {
      // already dead
    }
    return;
  }

  try {
    // Recursively find and kill all descendant processes
    const children = execSync(`pgrep -P ${pid} 2>/dev/null`, {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean);
    for (const childPid of children) {
      killDescendants(Number(childPid));
    }
  } catch (_err) {
    // no children
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (_err) {
    // already dead
  }
}

// npm injects npm_config_* / npm_* / INIT_CWD into any script it runs. These
// leak all the way down into the ORGII Rust process and its embedded PTY
// shells, where nvm complains ("nvm is not compatible with npm_config_prefix").
// Scrub them before handing env off to the tauri/orgii child.
function cleanChildEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("npm_") || key === "INIT_CWD") {
      delete env[key];
    }
  }
  return applyDefaultDiagnosticsEndpoint(env);
}

function createBinPath(name) {
  const isWindows = process.platform === "win32";
  const localPath = path.join(
    rootDir,
    "node_modules",
    ".bin",
    isWindows ? `${name}.cmd` : name
  );
  return fs.existsSync(localPath) ? localPath : name;
}

function createNodePackageCliCommand(packageName, binName, fallbackBinName) {
  if (process.platform !== "win32") {
    return {
      command: createBinPath(fallbackBinName ?? binName),
      argsPrefix: [],
    };
  }

  const packageJsonPath = require.resolve(`${packageName}/package.json`, {
    paths: [rootDir, __dirname],
  });
  const packageJson = require(packageJsonPath);
  const bin =
    typeof packageJson.bin === "string"
      ? packageJson.bin
      : packageJson.bin?.[binName];
  if (!bin) {
    throw new Error(`${packageName} does not expose a ${binName} CLI binary`);
  }

  return {
    command: process.execPath,
    argsPrefix: [path.resolve(path.dirname(packageJsonPath), bin)],
  };
}

function createPackageCliCommand(packageName, binName) {
  return createNodePackageCliCommand(packageName, binName);
}

function createPnpmCliCommand() {
  if (process.platform !== "win32") {
    return { command: createBinPath("pnpm"), argsPrefix: [] };
  }

  try {
    return createNodePackageCliCommand("pnpm", "pnpm");
  } catch (_error) {
    // pnpm is commonly installed globally via Corepack/npm and is not listed as
    // a project dependency. Avoid pnpm.cmd + shell:true by locating pnpm.cjs.
  }

  const candidates = [
    process.env.PNPM_HOME && path.join(process.env.PNPM_HOME, "pnpm.cjs"),
    process.env.APPDATA &&
      path.join(
        process.env.APPDATA,
        "npm",
        "node_modules",
        "pnpm",
        "bin",
        "pnpm.cjs"
      ),
    process.env.LOCALAPPDATA &&
      path.join(
        process.env.LOCALAPPDATA,
        "pnpm",
        "global",
        "5",
        "node_modules",
        "pnpm",
        "bin",
        "pnpm.cjs"
      ),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { command: process.execPath, argsPrefix: [candidate] };
    }
  }

  return { command: createBinPath("pnpm"), argsPrefix: [] };
}

function pipeProcessLines(childProcess, onLine) {
  function handleStream(stream) {
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on("line", onLine);
  }

  handleStream(childProcess.stdout);
  handleStream(childProcess.stderr);
}

function startFrontendDev() {
  const scriptName = createFrontendScriptName({
    lightDev: process.env.ORGII_LIGHT_DEV === "true",
  });
  const pnpmCli = createPnpmCliCommand();

  setWebpackStatus("starting dev server...");
  printStartupMilestone("starting webpack dev server", "webpackStart");

  const frontendProcess = spawn(
    pnpmCli.command,
    [...pnpmCli.argsPrefix, "run", scriptName],
    {
      stdio: ["inherit", "pipe", "pipe"],
      cwd: rootDir,
      env: cleanChildEnv(),
    }
  );

  const ready = new Promise((resolve, reject) => {
    let settled = false;
    let probingAsset = false;

    pipeProcessLines(frontendProcess, (line) => {
      routeLine(line);
      if (!settled && !probingAsset && isInitialWebpackReadyLine(line)) {
        probingAsset = true;
        printStartupMilestone("webpack initial compile done", "webpackDone");
        setWebpackStatus("verifying /main.js...");
        waitForDevServerAsset(`${createDevUrl()}/main.js`)
          .then(() => {
            if (!settled) {
              settled = true;
              setWebpackStatus("\x1b[32mHTTP ready\x1b[0m /main.js");
              printStartupMilestone("main.js HTTP ready", "mainJsReady");
              resolve();
            }
          })
          .catch((error) => {
            if (!settled) {
              settled = true;
              reject(error);
            }
          });
      }
    });

    frontendProcess.on("exit", (code) => {
      if (!settled) {
        settled = true;
        reject(
          new Error(
            `Frontend dev server exited before initial compile (${code})`
          )
        );
      }
    });

    frontendProcess.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });

  return { process: frontendProcess, ready };
}

function startTauriDev(features) {
  const args = createTauriArgs({
    features,
    devUrl: createDevUrl(),
  });
  const tauriCli = createPackageCliCommand("@tauri-apps/cli", "tauri");
  recordStartupMetric("rustStart");
  printStartupMilestone("starting Tauri dev process", "tauriStart");
  const tauriProcess = spawn(
    tauriCli.command,
    [...tauriCli.argsPrefix, ...args],
    {
      stdio: ["inherit", "pipe", "pipe"],
      cwd: rootDir,
      env: cleanChildEnv(),
    }
  );

  // Initialize status bar once the process starts
  writeStatusBar();

  pipeProcessLines(tauriProcess, routeLine);

  return tauriProcess;
}

function shutdownProcesses(processes, signal) {
  console.log(`\n🛑 Shutting down (${signal})...`);
  for (const childProcess of processes) {
    if (childProcess?.pid) {
      killDescendants(childProcess.pid);
    }
  }
  setTimeout(() => {
    for (const childProcess of processes) {
      if (childProcess?.pid) {
        try {
          process.kill(childProcess.pid, "SIGKILL");
        } catch (_err) {
          /* already dead */
        }
      }
    }
    process.exit(1);
  }, 3000).unref();
}

async function startDev(features) {
  devStartupStartedAt = Date.now();
  startupMetrics = createStartupMetrics();

  // Initialize status bar before the frontend process starts emitting progress.
  writeStatusBar();

  const managedProcesses = [];
  let shuttingDown = false;

  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    shutdownProcesses(managedProcesses, signal);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  const frontend = startFrontendDev();
  managedProcesses.push(frontend.process);

  frontend.ready
    .then(() => {
      if (shuttingDown) return;

      printStartupMilestone("frontend ready; opening WebView");
      const tauriProcess = startTauriDev(features);
      managedProcesses.push(tauriProcess);

      frontend.process.on("exit", (code) => {
        if (!shuttingDown) {
          shuttingDown = true;
          console.error(`❌ Frontend dev server exited (${code})`);
          shutdownProcesses([tauriProcess], "frontend exited");
        }
      });

      tauriProcess.on("error", (error) => {
        if (!shuttingDown) {
          shuttingDown = true;
          console.error("❌ Failed to start Tauri:", error.message);
          shutdownProcesses([frontend.process], "tauri failed");
        }
      });

      tauriProcess.on("exit", (code) => {
        if (isTTY && statusBarActive) {
          process.stdout.write("\x1b[3A\x1b[0J");
        }
        if (!shuttingDown) {
          shuttingDown = true;
          if (frontend.process.pid) {
            killDescendants(frontend.process.pid);
          }
          process.exit(code || 0);
        }
      });
    })
    .catch((error) => {
      if (!shuttingDown) {
        shuttingDown = true;
        console.error("❌ Dev startup failed:", error.message);
        shutdownProcesses(managedProcesses, "startup failed");
      }
    });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const features = tauriFeatureList();

  printBanner(features);

  cleanupOrphanedProcesses();
  await startDev(features);
}

main().catch((error) => {
  console.error("❌ Failed to start dev mode:", error.message);
  process.exit(1);
});
