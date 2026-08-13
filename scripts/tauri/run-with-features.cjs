#!/usr/bin/env node

/**
 * Runs `tauri <subcommand>` with the right --features for this OS.
 */

const { spawnSync } = require("child_process");
const path = require("path");
const { tauriFeatureString } = require("./features.cjs");
const {
  applyDefaultDiagnosticsEndpoint,
} = require("./diagnostics-endpoint.cjs");

require("dotenv").config({ path: path.join(__dirname, "..", "..", ".env") });

const subcommand = process.argv[2];
if (!subcommand) {
  console.error("Usage: node scripts/tauri/run-with-features.cjs <dev|build|...> [extra tauri args...]");
  process.exit(1);
}

const rawExtraArgs = process.argv.slice(3);
const includeSemantic = rawExtraArgs.includes("--semantic");
const featureString = tauriFeatureString({ semantic: includeSemantic });
const extraArgs = rawExtraArgs.filter((arg) => arg !== "--semantic");
const args = [subcommand];
if (featureString.length > 0) {
  args.push("--features", featureString);
}
args.push(...extraArgs);

const rootDir = path.join(__dirname, "..", "..");

// `externalBin` requires the staged org2-pm sidecar to exist before the
// tauri CLI starts (dev copies it next to the debug binary; build bundles
// and signs it).
if (subcommand === "dev" || subcommand === "build") {
  const targetIndex = extraArgs.indexOf("--target");
  const sidecarArgs = [
    path.join(__dirname, "prepare-sidecars.cjs"),
    "--profile",
    subcommand === "build" ? "release" : "debug",
  ];
  if (targetIndex >= 0 && extraArgs[targetIndex + 1]) {
    sidecarArgs.push("--target", extraArgs[targetIndex + 1]);
  }
  const sidecarResult = spawnSync(process.execPath, sidecarArgs, {
    stdio: "inherit",
    cwd: rootDir,
  });
  if (sidecarResult.status !== 0) {
    process.exit(sidecarResult.status ?? 1);
  }
}

const result = spawnSync("tauri", args, {
  stdio: "inherit",
  shell: true,
  cwd: rootDir,
  env: applyDefaultDiagnosticsEndpoint({ ...process.env }),
});

process.exit(result.status ?? 1);
