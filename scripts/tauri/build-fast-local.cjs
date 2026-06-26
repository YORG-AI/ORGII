#!/usr/bin/env node

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { tauriFeatureString } = require("./features.cjs");
const {
  applyDefaultDiagnosticsEndpoint,
} = require("./diagnostics-endpoint.cjs");

const rootDir = path.join(__dirname, "..", "..");
const includeSemantic = process.argv.includes("--semantic");
const featureString = tauriFeatureString({ semantic: includeSemantic });

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

const configOverride = JSON.stringify({
  build: {
    beforeBuildCommand: "webpack --mode production",
  },
  bundle: {
    createUpdaterArtifacts: false,
    macOS: {
      signingIdentity: null,
    },
  },
});

const env = applyDefaultDiagnosticsEndpoint({ ...process.env });
for (const key of [
  "APPLE_ID",
  "APPLE_PASSWORD",
  "APPLE_TEAM_ID",
  "APPLE_API_KEY",
  "APPLE_API_KEY_PATH",
  "APPLE_API_ISSUER",
]) {
  delete env[key];
}

const args = ["build"];
if (featureString.length > 0) {
  args.push("--features", featureString);
}
args.push("--bundles", "app", "--config", configOverride, "--", "--profile", "dev-build");

const tauriCommand = createPnpmExecCommand("tauri", args);
const result = spawnSync(tauriCommand.cmd, tauriCommand.args, {
  stdio: "inherit",
  cwd: rootDir,
  env,
});

process.exit(result.status ?? 1);
