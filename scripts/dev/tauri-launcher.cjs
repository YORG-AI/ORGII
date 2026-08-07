#!/usr/bin/env node

const { spawn } = require("node:child_process");
const path = require("node:path");

const rootDir = path.join(__dirname, "..", "..");
const args = process.argv.slice(2);
const env = { ...process.env };

if (args.includes("--light")) {
  env.ORGII_LIGHT_DEV = "true";
}

const child = spawn(process.execPath, [path.join(__dirname, "tauri.js")], {
  cwd: rootDir,
  env,
  detached: process.platform !== "win32",
  stdio: ["ignore", "inherit", "inherit"],
});

let exiting = false;
const signalExitCodes = {
  SIGINT: 130,
  SIGTERM: 143,
};

function forwardSignal(signal) {
  if (exiting || !child.pid) {
    return;
  }

  try {
    process.kill(child.pid, signal);
  } catch (_error) {
    // The child may already have exited.
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    forwardSignal(signal);
  });
}

child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  exiting = true;
  if (signal) {
    process.exit(signalExitCodes[signal] ?? 1);
    return;
  }
  process.exit(code ?? 0);
});
