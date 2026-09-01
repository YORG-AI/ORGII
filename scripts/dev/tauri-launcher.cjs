#!/usr/bin/env node

const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");

const rootDir = path.join(__dirname, "..", "..");
const args = process.argv.slice(2);
const env = { ...process.env };

if (args.includes("--light")) {
  env.ORGII_LIGHT_DEV = "true";
}

if (args.includes("--rspack")) {
  env.ORGII_RSPACK = "true";
}

if (args.includes("--webpack")) {
  env.ORGII_RSPACK = "false";
}

// Bound the build caches before the compiler starts.
//
// This is the only moment in a dev session when it is safe *and* useful:
// nothing is compiling yet, no app binary is running out of the target dir,
// and `cargo-sweep` evicts oldest-first - so stale branch and worktree
// artifacts go while the artifacts for the build about to run survive.
// The whole check costs well under a second; if anything goes wrong we let
// the dev server start anyway rather than block on housekeeping.
if (!args.includes("--no-cache-guard") && env.ORGII_SKIP_CACHE_GUARD !== "1") {
  const guard = spawnSync(
    process.execPath,
    [path.join(__dirname, "clean-cache-if-large.js")],
    { cwd: rootDir, env, stdio: ["ignore", "inherit", "inherit"] }
  );
  if (guard.error) {
    console.warn(`[cache-guard] skipped: ${guard.error.message}`);
  }
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
