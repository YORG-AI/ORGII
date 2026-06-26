#!/usr/bin/env node

/**
 * Cross-platform entry for orphaned dev-process cleanup.
 * Windows: native Node/PowerShell (no WSL or bash required).
 * Unix: delegates to cleanup-orphans.sh.
 *
 * Usage: node scripts/dev/cleanup-orphans.cjs [--quiet]
 */

const { execSync } = require("child_process");
const path = require("path");

const quiet = process.argv.includes("--quiet");

function runWindowsCleanup() {
  const patterns = [
    { label: "webpack dev server", match: "scripts/dev/webpack-server.js" },
    { label: "webpack dev server", match: "scripts\\dev\\webpack-server.js" },
    { label: "build watchers", match: "build.js --watch" },
    { label: "esbuild services", match: "esbuild --service" },
    { label: "ORG2 Dev", match: "ORG2 Dev" },
    { label: "orphaned cargo run", match: "cargo run" },
  ];

  const killed = [];

  for (const { label, match } of patterns) {
    const count = killProcessesMatching(match);
    if (count > 0) {
      killed.push(`${label}=${count}`);
    }
  }

  const portPid = getListenerPid(1998);
  if (portPid) {
    killPid(portPid);
    killed.push(`port-1998=${portPid}`);
  }

  if (killed.length === 0) {
    if (!quiet) {
      console.log("✅ No orphaned processes found. System is clean!");
    }
    return;
  }

  if (quiet) {
    console.log(`🧹 Cleanup: ${killed.join(" ")}`);
  } else {
    console.log("🧹 Cleaning up orphaned development processes...");
    console.log(`✅ Cleanup: ${killed.join(", ")}`);
  }
}

function killProcessesMatching(fragment) {
  const escaped = fragment.replace(/'/g, "''");
  const script = [
    "$pids = Get-CimInstance Win32_Process",
    `| Where-Object { $_.CommandLine -and $_.CommandLine -like '*${escaped}*' }`,
    "| Select-Object -ExpandProperty ProcessId",
    "if ($pids) {",
    "  $pids | ForEach-Object {",
    "    Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue",
    "  }",
    "  ($pids | Measure-Object).Count",
    "} else { 0 }",
  ].join(" ");

  try {
    const out = execSync(`powershell -NoProfile -Command "${script}"`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return Number.parseInt(out, 10) || 0;
  } catch {
    return 0;
  }
}

function getListenerPid(port) {
  const script = [
    `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue`,
    "| Select-Object -First 1 -ExpandProperty OwningProcess",
    "if ($c) { $c } else { '' }",
  ].join(" ");

  try {
    const out = execSync(`powershell -NoProfile -Command "${script}"`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const pid = Number.parseInt(out, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function killPid(pid) {
  try {
    execSync(`taskkill /PID ${pid} /F /T`, { stdio: "ignore" });
  } catch {
    // Non-fatal
  }
}

function runUnixCleanup() {
  const bashScript = path.join(__dirname, "cleanup-orphans.sh");
  const args = quiet ? "--quiet" : "";
  execSync(`bash "${bashScript}" ${args}`, {
    stdio: "inherit",
    cwd: path.join(__dirname, "..", ".."),
  });
}

if (process.platform === "win32") {
  runWindowsCleanup();
} else {
  runUnixCleanup();
}
