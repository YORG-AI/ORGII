#!/usr/bin/env node
/**
 * Build the primary app and instance 2 concurrently on Windows.
 *
 * The two Tauri identities cannot share Cargo's final `org2.exe` artifact
 * while linking. Give each build a persistent target directory instead, so
 * both links can run at once and retain their own incremental caches.
 *
 * Usage:
 *   pnpm run tauri:build:fast:dual
 *   pnpm run tauri:build:fast:dual -- --semantic
 */

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const rootDir = path.join(__dirname, "..", "..");
const buildScript = path.join(__dirname, "build-fast-parallel.cjs");
const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const forwardedFlags = rawArgs.filter((arg) => arg === "--semantic");
// Keep the primary build on Cargo's normal target directory so it reuses the
// cache produced by ordinary checks/builds. Only instance 2 needs a separate
// persistent directory to prevent the two linkers from racing on org2.exe.
const primaryTarget = path.join(rootDir, "src-tauri", "target");
const instance2Target = path.join(rootDir, "src-tauri", "target-instance2");
const canonicalDir = path.join(rootDir, "src-tauri", "target", "dev-build");
const profileDir = "dev-build";
const jobsPerBuild = Math.max(1, Math.floor(os.cpus().length / 2));

function seedInstanceTarget() {
  const source = path.join(primaryTarget, profileDir);
  const destination = path.join(instance2Target, profileDir);
  const sentinel = path.join(
    instance2Target,
    `.orgii-seeded-from-${profileDir}`
  );
  if (fs.existsSync(sentinel) || !fs.existsSync(source)) return;

  console.log(
    `\x1b[1m[build-fast-dual] Seeding instance2 ${profileDir} dependency cache from main target\x1b[0m`
  );
  fs.mkdirSync(destination, { recursive: true });
  if (process.platform === "win32") {
    const result = spawnSync(
      "robocopy",
      [
        source,
        destination,
        "/E",
        "/MT:16",
        "/R:1",
        "/W:1",
        "/XD",
        path.join(source, "bundle"),
        path.join(source, "incremental"),
        "/XF",
        "org2.exe",
        "org2.pdb",
        "/NFL",
        "/NDL",
        "/NP",
      ],
      { cwd: rootDir, stdio: "inherit" }
    );
    // Robocopy codes 0-7 are success states (including files copied).
    if (result.status === null || result.status >= 8) {
      throw new Error(
        `Failed to seed instance2 Cargo cache (${result.status})`
      );
    }
  } else {
    fs.cpSync(source, destination, {
      recursive: true,
      filter: (entry) =>
        !["bundle", "incremental"].includes(path.basename(entry)),
    });
  }

  const rustInfo = path.join(primaryTarget, ".rustc_info.json");
  if (fs.existsSync(rustInfo)) {
    fs.copyFileSync(rustInfo, path.join(instance2Target, ".rustc_info.json"));
  }
  fs.writeFileSync(sentinel, `${new Date().toISOString()}\n`);
}

function runFrontendBuild() {
  const result = spawnSync(
    process.execPath,
    [buildScript, "--frontend-only", ...forwardedFlags],
    {
      cwd: rootDir,
      env: process.env,
      stdio: "inherit",
    }
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function runIdentityBuild(label, targetDir, instanceId) {
  const args = [buildScript, "--skip-frontend", ...forwardedFlags];
  if (instanceId) args.push("--instance", instanceId);

  console.log(
    `\x1b[1m[build-fast-dual] Starting ${label} with CARGO_TARGET_DIR=${targetDir}\x1b[0m`
  );
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: rootDir,
      env: {
        ...process.env,
        CARGO_BUILD_JOBS: String(jobsPerBuild),
        // This command already gives each identity its own target directory,
        // so the cross-process incremental-cache race documented in
        // src-tauri/.cargo/config.toml cannot occur between the two builds.
        // Opt in locally to avoid recompiling the entire app crate whenever
        // only embedded frontend assets changed.
        CARGO_INCREMENTAL: "1",
        CARGO_TARGET_DIR: targetDir,
      },
      stdio: "inherit",
    });
    child.once("error", (error) => resolve({ label, code: 1, error }));
    child.once("exit", (code) => resolve({ label, code: code ?? 1 }));
  });
}

function copyResult(source, destination) {
  if (!fs.existsSync(source)) {
    throw new Error(`Expected build output missing: ${source}`);
  }
  if (path.resolve(source) === path.resolve(destination)) return;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

async function main() {
  const startedAt = Date.now();
  seedInstanceTarget();
  runFrontendBuild();

  const results = await Promise.all([
    runIdentityBuild("main", primaryTarget, null),
    runIdentityBuild("instance2", instance2Target, "2"),
  ]);
  const failed = results.find((result) => result.code !== 0);
  if (failed) {
    console.error(
      `[build-fast-dual] ${failed.label} failed with code ${failed.code}`,
      failed.error ?? ""
    );
    process.exit(failed.code);
  }

  const primaryExe = path.join(primaryTarget, profileDir, "org2.exe");
  const instance2Exe = path.join(instance2Target, profileDir, "org2.exe");
  copyResult(primaryExe, path.join(canonicalDir, "org2.exe"));
  copyResult(primaryExe, path.join(canonicalDir, "org2-main.exe"));
  copyResult(instance2Exe, path.join(canonicalDir, "org2-instance2.exe"));

  console.log(
    `\x1b[32m[build-fast-dual] Built both identities in ${(
      (Date.now() - startedAt) /
      1000
    ).toFixed(1)}s\x1b[0m`
  );
  console.log(`  profile:   ${profileDir}, ${jobsPerBuild} jobs per identity`);
  console.log(`  main:      ${path.join(canonicalDir, "org2-main.exe")}`);
  console.log(`  instance2: ${path.join(canonicalDir, "org2-instance2.exe")}`);
}

main().catch((error) => {
  console.error("[build-fast-dual] fatal:", error);
  process.exit(1);
});
