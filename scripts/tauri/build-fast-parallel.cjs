#!/usr/bin/env node
/**
 * Parallel local fast build.
 *
 * Standard `tauri:build:fast` serialises work:
 *   webpack (beforeBuildCommand) → then Rust compile → then bundle
 *
 * This script runs the two independent phases concurrently:
 *   1. webpack --mode production   (JS bundle → build/)
 *   2. cargo build --profile dev-build  (Rust → target/dev-build/)
 *
 * Tauri is invoked after both finish, but because the JS bundle and
 * Rust artifacts are already on disk it only has to copy + assemble
 * the .app — no recompilation happens.
 *
 * On a 10-core M-series Mac the parallel phase typically saves 60-90s
 * (webpack ~40s and Rust ~3-5min are fully overlapped).
 *
 * Usage:
 *   pnpm run tauri:build:fast
 *   pnpm run tauri:build:fast -- /tmp/ORG2.app
 *   pnpm run tauri:build:fast -- ~/Desktop
 *   pnpm run tauri:build:fast -- --semantic ~/Desktop
 */

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { tauriFeatureString } = require("./features.cjs");
const {
  applyDefaultDiagnosticsEndpoint,
} = require("./diagnostics-endpoint.cjs");

const rootDir = path.join(__dirname, "..", "..");
const rawArgs = process.argv.slice(2);
const includeSemantic = rawArgs.includes("--semantic");
const outputPathArg = rawArgs.find((arg) => arg !== "--semantic");
const featureString = tauriFeatureString({ semantic: includeSemantic });

// ─── helpers ──────────────────────────────────────────────────────────────────

function prefix(tag, color) {
  return (data) => {
    const reset = "\x1b[0m";
    const lines = data.toString().split("\n");
    for (const line of lines) {
      if (line.trim()) process.stdout.write(`${color}[${tag}]${reset} ${line}\n`);
    }
  };
}

function createBinPath(name) {
  const localPath = path.join(
    rootDir,
    "node_modules",
    ".bin",
    process.platform === "win32" ? `${name}.cmd` : name
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

function createPnpmCliCommand() {
  if (process.platform !== "win32") {
    return { command: createBinPath("pnpm"), argsPrefix: [] };
  }

  try {
    return createNodePackageCliCommand("pnpm", "pnpm");
  } catch (_error) {
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

function createPnpmExecCommand(binaryName, args) {
  const pnpmCli = createPnpmCliCommand();
  return {
    cmd: pnpmCli.command,
    args: [...pnpmCli.argsPrefix, "exec", binaryName, ...args],
  };
}

function runParallel(commands) {
  return new Promise((resolve) => {
    const results = new Array(commands.length).fill(null);
    let remaining = commands.length;

    commands.forEach(({ cmd, args, opts, tag, color }, idx) => {
      const child = spawn(cmd, args, {
        cwd: rootDir,
        env: { ...process.env, FORCE_COLOR: "1" },
        shell: false,
        ...opts,
      });

      const log = prefix(tag, color);
      child.stdout?.on("data", log);
      child.stderr?.on("data", log);

      child.on("close", (code) => {
        results[idx] = code ?? 1;
        remaining -= 1;
        if (remaining === 0) resolve(results);
      });
    });
  });
}

function resolveCargoTargetDir() {
  const metadataResult = spawnSync(
    "cargo",
    ["metadata", "--format-version", "1", "--no-deps"],
    {
      cwd: path.join(rootDir, "src-tauri"),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }
  );

  if (metadataResult.status !== 0) {
    console.error("Failed to resolve Cargo target directory via cargo metadata");
    process.exit(metadataResult.status ?? 1);
  }

  const metadata = JSON.parse(metadataResult.stdout);
  return metadata.target_directory;
}

function resolveOutputAppPath(outputPath) {
  const resolved = path.resolve(rootDir, outputPath);
  return path.extname(resolved) === ".app"
    ? resolved
    : path.join(resolved, "ORG2.app");
}

function copyBuiltApp(outputPath) {
  if (!outputPath || process.platform !== "darwin") return;

  const targetDir = resolveCargoTargetDir();
  const builtAppPath = path.join(targetDir, "dev-build", "bundle", "macos", "ORG2.app");
  if (!fs.existsSync(builtAppPath)) {
    console.error(`Built app not found at ${builtAppPath}`);
    process.exit(1);
  }

  const destinationAppPath = resolveOutputAppPath(outputPath);
  fs.mkdirSync(path.dirname(destinationAppPath), { recursive: true });
  fs.rmSync(destinationAppPath, { recursive: true, force: true });
  fs.cpSync(builtAppPath, destinationAppPath, { recursive: true });
  console.log(`\x1b[32m[build-fast-parallel] Copied app to ${destinationAppPath}\x1b[0m`);
}

// ─── env: strip all signing/notarization so no certificate is required ────────
//
// Without this, tauri falls back to ad-hoc signing (-) which still invokes
// codesign on every binary and adds ~10-20s with no benefit for a local build.
// Setting CODESIGN_IDENTITY="" tells tauri-bundler to skip codesign entirely.

const env = { ...process.env };
for (const key of [
  "APPLE_ID",
  "APPLE_PASSWORD",
  "APPLE_TEAM_ID",
  "APPLE_API_KEY",
  "APPLE_API_KEY_PATH",
  "APPLE_API_ISSUER",
  "CODESIGN_IDENTITY",
]) {
  delete env[key];
}
env.CODESIGN_IDENTITY = "";
applyDefaultDiagnosticsEndpoint(env);

// ─── phase 1: webpack + cargo in parallel ─────────────────────────────────────

async function main() {
  console.log("\x1b[1m[build-fast-parallel] Phase 1: webpack + cargo (parallel)\x1b[0m");
  const t0 = Date.now();

  // Derive cargo args for dev-build
  const cargoArgs = ["build", "--profile", "dev-build"];
  if (featureString.length > 0) {
    cargoArgs.push("--features", featureString);
  }
  // Point cargo at the src-tauri workspace root
  cargoArgs.push("--manifest-path", path.join(rootDir, "src-tauri", "Cargo.toml"));

  const webpackCommand = createPnpmExecCommand("webpack", ["--mode", "production"]);
  const [webpackCode, cargoCode] = await runParallel([
    {
      ...webpackCommand,
      // FAST_PROD=true: use esbuild for transpilation + minification
      // instead of SWC+Terser, saving ~30-40s on the webpack phase.
      opts: { env: { ...env, FAST_PROD: "true" } },
      tag: "webpack",
      color: "\x1b[34m", // blue
    },
    {
      cmd: "cargo",
      args: cargoArgs,
      opts: { env, cwd: rootDir },
      tag: "cargo",
      color: "\x1b[33m", // yellow
    },
  ]);

  const phase1Ms = Date.now() - t0;
  console.log(
    `\x1b[1m[build-fast-parallel] Phase 1 done in ${(phase1Ms / 1000).toFixed(1)}s` +
      ` (webpack=${webpackCode} cargo=${cargoCode})\x1b[0m`
  );

  if (webpackCode !== 0 || cargoCode !== 0) {
    process.exit(Math.max(webpackCode, cargoCode));
  }

  // ─── phase 2: tauri assemble-only (no recompile, no beforeBuildCommand) ─────

  console.log("\x1b[1m[build-fast-parallel] Phase 2: tauri bundle (assemble only)\x1b[0m");

  const configOverride = JSON.stringify({
    build: {
      // Empty string = skip beforeBuildCommand; artifacts already on disk.
      beforeBuildCommand: "",
    },
    bundle: {
      createUpdaterArtifacts: false,
      macOS: {
        // null = no Developer ID signing. Combined with CODESIGN_IDENTITY=""
        // in env, tauri-bundler skips codesign entirely — no certificate needed,
        // no ad-hoc signing pass, no entitlements processing.
        signingIdentity: null,
        entitlements: null,
      },
    },
  });

  const bundleTarget = process.platform === "darwin" ? "app" : "nsis";
  const tauriArgs = ["build"];
  if (featureString.length > 0) {
    tauriArgs.push("--features", featureString);
  }
  tauriArgs.push(
    "--bundles", bundleTarget,
    "--config", configOverride,
    "--",
    "--profile", "dev-build"
  );

  const tauriCommand = createPnpmExecCommand("tauri", tauriArgs);
  const result = spawnSync(tauriCommand.cmd, tauriCommand.args, {
    stdio: "inherit",
    cwd: rootDir,
    env,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  copyBuiltApp(outputPathArg);

  const totalMs = Date.now() - t0;
  console.log(
    `\x1b[1m[build-fast-parallel] Total: ${(totalMs / 1000).toFixed(1)}s\x1b[0m`
  );

  process.exit(0);
}

main().catch((err) => {
  console.error("[build-fast-parallel] fatal:", err);
  process.exit(1);
});
