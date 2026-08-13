#!/usr/bin/env node

/**
 * Builds the `org2-pm` CLI and stages it where tauri's `externalBin`
 * expects it: `src-tauri/binaries/org2-pm-<target-triple>[.exe]`.
 *
 * Unlike the downloaded sidecars (peekaboo, agent-browser, git — fetched
 * into ~/.orgii/bin at first launch), org2-pm is built from this repo and
 * version-locked to the app: agents resolve it via the PATH prepend that
 * points at the app binary's own directory, so the bundle must carry the
 * exact matching build.
 *
 * Usage:
 *   node scripts/tauri/prepare-sidecars.cjs [--profile <debug|release|dev-build>] [--target <triple>]
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const rootDir = path.join(__dirname, "..", "..");
const srcTauriDir = path.join(rootDir, "src-tauri");
const rawArgs = process.argv.slice(2);

function argValue(flag) {
  const index = rawArgs.indexOf(flag);
  return index >= 0 ? (rawArgs[index + 1] ?? null) : null;
}

const profile = argValue("--profile") ?? "debug";
const explicitTarget = argValue("--target");

function hostTriple() {
  const result = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
  if (result.status !== 0) {
    console.error("[prepare-sidecars] rustc -vV failed");
    process.exit(result.status ?? 1);
  }
  const match = result.stdout.match(/host: (\S+)/);
  if (!match) {
    console.error("[prepare-sidecars] could not parse host triple from rustc -vV");
    process.exit(1);
  }
  return match[1];
}

function cargoTargetDir() {
  const result = spawnSync(
    "cargo",
    ["metadata", "--format-version", "1", "--no-deps"],
    { cwd: srcTauriDir, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }
  );
  if (result.status !== 0) {
    console.error("[prepare-sidecars] cargo metadata failed");
    process.exit(result.status ?? 1);
  }
  return JSON.parse(result.stdout).target_directory;
}

const triple = explicitTarget ?? hostTriple();
const exeSuffix = triple.includes("windows") ? ".exe" : "";

const cargoArgs = ["build", "-p", "orgtrack-pm-cli", "--bin", "org2-pm"];
if (profile === "release") {
  cargoArgs.push("--release");
} else if (profile !== "debug") {
  cargoArgs.push("--profile", profile);
}
if (explicitTarget) {
  cargoArgs.push("--target", explicitTarget);
}

console.log(`[prepare-sidecars] cargo ${cargoArgs.join(" ")}`);
const build = spawnSync("cargo", cargoArgs, {
  cwd: srcTauriDir,
  stdio: "inherit",
  env: process.env,
});
if (build.status !== 0) {
  console.error("[prepare-sidecars] org2-pm build failed");
  process.exit(build.status ?? 1);
}

const profileDir = profile === "debug" ? "debug" : profile;
const builtPath = path.join(
  cargoTargetDir(),
  ...(explicitTarget ? [explicitTarget] : []),
  profileDir,
  `org2-pm${exeSuffix}`
);
if (!fs.existsSync(builtPath)) {
  console.error(`[prepare-sidecars] built binary not found at ${builtPath}`);
  process.exit(1);
}

const stagingDir = path.join(srcTauriDir, "binaries");
fs.mkdirSync(stagingDir, { recursive: true });
const stagedPath = path.join(stagingDir, `org2-pm-${triple}${exeSuffix}`);
fs.copyFileSync(builtPath, stagedPath);
if (process.platform !== "win32") {
  fs.chmodSync(stagedPath, 0o755);
}
console.log(`[prepare-sidecars] staged ${stagedPath}`);
