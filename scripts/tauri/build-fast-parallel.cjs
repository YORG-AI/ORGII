#!/usr/bin/env node
/**
 * Local fast build.
 *
 * Standard `tauri:build:fast` serialises work:
 *   webpack (beforeBuildCommand) → then Rust compile → then bundle
 *
 * Builds webpack once, then lets Tauri compile and bundle the custom
 * `dev-build` profile once. A direct Cargo pre-build cannot be reused by the
 * Tauri CLI because its merged-config fingerprint differs, so attempting to
 * parallelize those steps causes two full Rust compilations.
 *
 * Usage:
 *   pnpm run tauri:build:fast
 *   pnpm run tauri:build:fast -- /tmp/ORG2.app
 *   pnpm run tauri:build:fast -- ~/Desktop
 *   pnpm run tauri:build:fast -- --semantic ~/Desktop
 *   pnpm run tauri:build:fast -- --instance 2
 *   pnpm run tauri:build:fast -- --instance 2 --skip-frontend
 *   pnpm run tauri:build:fast -- --bundle
 *   pnpm run tauri:build:fast -- --frontend-only
 *
 * On Windows, the fast build skips NSIS packaging by default because local UI
 * testing only needs the executable. Pass `--bundle` when an installer is
 * actually required. `--skip-frontend` reuses the existing webpack output,
 * which is useful when linking an independently identified second instance.
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { tauriFeatureString } = require("./features.cjs");
const {
  applyDefaultDiagnosticsEndpoint,
} = require("./diagnostics-endpoint.cjs");
const { createInstanceProfile } = require("./instance-profile.cjs");
const { verifyWebpackRuntimeGuards } = require("./verify-webpack-runtime.cjs");

const rootDir = path.join(__dirname, "..", "..");
const rawArgs = process.argv.slice(2);
const includeSemantic = rawArgs.includes("--semantic");
const skipFrontend = rawArgs.includes("--skip-frontend");
const frontendOnly = rawArgs.includes("--frontend-only");
const forceBundle = rawArgs.includes("--bundle");
const instanceOptionIndex = rawArgs.indexOf("--instance");
const instanceProfile =
  instanceOptionIndex >= 0
    ? createInstanceProfile(rawArgs[instanceOptionIndex + 1])
    : null;
const positionalArgs = rawArgs.filter((arg, index) => {
  if (
    arg === "--" ||
    arg === "--semantic" ||
    arg === "--skip-frontend" ||
    arg === "--frontend-only" ||
    arg === "--bundle" ||
    arg === "--instance"
  ) {
    return false;
  }
  return instanceOptionIndex < 0 || index !== instanceOptionIndex + 1;
});
const outputPathArg = positionalArgs[0];
const featureString = tauriFeatureString({ semantic: includeSemantic });
const productName = instanceProfile?.productName ?? "ORG2";
const shouldBundle = process.platform !== "win32" || forceBundle;

// ─── helpers ──────────────────────────────────────────────────────────────────

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

function createPackageCliCommand(packageName, binName, args) {
  const packageCli = createNodePackageCliCommand(packageName, binName);
  return {
    cmd: packageCli.command,
    args: [...packageCli.argsPrefix, ...args],
  };
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
    console.error(
      "Failed to resolve Cargo target directory via cargo metadata"
    );
    process.exit(metadataResult.status ?? 1);
  }

  const metadata = JSON.parse(metadataResult.stdout);
  return metadata.target_directory;
}

function resolveOutputAppPath(outputPath) {
  const resolved = path.resolve(rootDir, outputPath);
  return path.extname(resolved) === ".app"
    ? resolved
    : path.join(resolved, `${productName}.app`);
}

function copyBuiltApp(outputPath) {
  if (!outputPath || process.platform !== "darwin") return;

  const targetDir = resolveCargoTargetDir();
  const builtAppPath = path.join(
    targetDir,
    "dev-build",
    "bundle",
    "macos",
    `${productName}.app`
  );
  if (!fs.existsSync(builtAppPath)) {
    console.error(`Built app not found at ${builtAppPath}`);
    process.exit(1);
  }

  const destinationAppPath = resolveOutputAppPath(outputPath);
  fs.mkdirSync(path.dirname(destinationAppPath), { recursive: true });
  fs.rmSync(destinationAppPath, { recursive: true, force: true });
  fs.cpSync(builtAppPath, destinationAppPath, { recursive: true });
  console.log(
    `\x1b[32m[build-fast-parallel] Copied app to ${destinationAppPath}\x1b[0m`
  );
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
if (instanceProfile) {
  env.ORGII_IDE_SERVER_PORT = String(instanceProfile.ideServerPort);
  env.ORGII_CLI_PROXY_PORT = String(instanceProfile.cliProxyPort);
  env.ORGII_DEEP_LINK_SCHEME = instanceProfile.authDeepLinkScheme;
}
applyDefaultDiagnosticsEndpoint(env);

// ─── phase 1: frontend ────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();

  if (skipFrontend && frontendOnly) {
    console.error(
      "[build-fast-parallel] --skip-frontend and --frontend-only cannot be combined"
    );
    process.exit(1);
  }

  if (skipFrontend) {
    const frontendEntry = path.join(rootDir, "build", "index.html");
    if (!fs.existsSync(frontendEntry)) {
      console.error(
        "[build-fast-parallel] --skip-frontend requires build/index.html"
      );
      process.exit(1);
    }
    console.log(
      "\x1b[1m[build-fast-parallel] Phase 1: reusing existing webpack output\x1b[0m"
    );
    const verification = verifyWebpackRuntimeGuards(
      path.join(rootDir, "build")
    );
    console.log(
      `[build-fast-parallel] Webpack runtime verified: ${verification.runtimeId}`
    );
  } else {
    console.log("\x1b[1m[build-fast-parallel] Phase 1: webpack\x1b[0m");
    const webpackCommand = createPackageCliCommand("webpack", "webpack", [
      "--mode",
      "production",
    ]);
    const webpackResult = spawnSync(webpackCommand.cmd, webpackCommand.args, {
      cwd: rootDir,
      env: { ...env, FAST_PROD: "true" },
      stdio: "inherit",
    });
    const webpackCode = webpackResult.status ?? 1;

    const phase1Ms = Date.now() - t0;
    console.log(
      `\x1b[1m[build-fast-parallel] Phase 1 done in ${(phase1Ms / 1000).toFixed(1)}s` +
        ` (webpack=${webpackCode})\x1b[0m`
    );

    if (webpackCode !== 0) process.exit(webpackCode);
    const verification = verifyWebpackRuntimeGuards(
      path.join(rootDir, "build")
    );
    console.log(
      `[build-fast-parallel] Webpack runtime verified: ${verification.runtimeId}`
    );
  }

  if (frontendOnly) {
    console.log(
      `\x1b[1m[build-fast-parallel] Frontend-only build completed in ${(
        (Date.now() - t0) /
        1000
      ).toFixed(1)}s\x1b[0m`
    );
    process.exit(0);
  }

  // ─── phase 2: one Rust compile + bundle ────────────────────────────────────

  console.log(
    "\x1b[1m[build-fast-parallel] Phase 2: tauri build + bundle\x1b[0m"
  );

  // Stage the org2-pm sidecar (externalBin) before the tauri CLI runs; it
  // shares the dev-build dep cache so this is nearly free after the first
  // compile.
  const sidecarResult = spawnSync(
    process.execPath,
    [
      path.join(__dirname, "prepare-sidecars.cjs"),
      "--profile",
      "dev-build",
    ],
    { cwd: rootDir, env, stdio: "inherit" }
  );
  if (sidecarResult.status !== 0) {
    process.exit(sidecarResult.status ?? 1);
  }

  const configOverride = JSON.stringify({
    ...(instanceProfile
      ? {
          productName: instanceProfile.productName,
          identifier: instanceProfile.identifier,
          plugins: {
            "deep-link": {
              desktop: { schemes: instanceProfile.deepLinkSchemes },
            },
            updater: { active: false },
          },
        }
      : {}),
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

  const tauriArgs = ["build"];
  if (featureString.length > 0) {
    tauriArgs.push("--features", featureString);
  }
  if (shouldBundle) {
    const bundleTarget =
      process.platform === "darwin"
        ? "app"
        : process.platform === "win32"
          ? "nsis"
          : "deb";
    tauriArgs.push("--bundles", bundleTarget);
  } else {
    tauriArgs.push("--no-bundle");
    console.log(
      "\x1b[1m[build-fast-parallel] Windows local build: skipping NSIS (pass --bundle to include it)\x1b[0m"
    );
  }
  tauriArgs.push("--config", configOverride, "--", "--profile", "dev-build");

  const tauriCommand = createPackageCliCommand(
    "@tauri-apps/cli",
    "tauri",
    tauriArgs
  );
  const result = spawnSync(tauriCommand.cmd, tauriCommand.args, {
    stdio: "inherit",
    cwd: rootDir,
    env,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  copyBuiltApp(outputPathArg);

  if (instanceProfile) {
    console.log(
      `\x1b[32m[build-fast-parallel] Instance ${instanceProfile.id}: ` +
        `${productName}.app, ${instanceProfile.identifier}, ` +
        `IDE ${instanceProfile.ideServerPort}, proxy ${instanceProfile.cliProxyPort}\x1b[0m`
    );
  }

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
