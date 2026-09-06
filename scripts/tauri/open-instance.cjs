#!/usr/bin/env node

const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createInstanceProfile } = require("./instance-profile.cjs");

function optionValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const profile = createInstanceProfile(optionValue("--instance"));
const rootDir = path.join(__dirname, "..", "..");
const appPath = path.resolve(
  optionValue("--app") ??
    path.join(
      rootDir,
      "src-tauri",
      "target",
      "dev-build",
      "bundle",
      "macos",
      `${profile.productName}.app`
    )
);
const dataHome = path.resolve(optionValue("--data-home") ?? profile.dataHome);
const externalHistoryHome = path.join(dataHome, "external-history-home");
// Publishing into a real provider profile is an explicit opt-in. Independent
// dev/E2E instances otherwise keep both discovery and materialization inside
// their isolated data home and cannot mutate one another's native catalogs.
const nativeTranscriptHomeOption =
  optionValue("--native-transcript-home") ??
  process.env.ORGII_NATIVE_TRANSCRIPT_HOME;
const nativeTranscriptHome = nativeTranscriptHomeOption
  ? path.resolve(nativeTranscriptHomeOption)
  : null;
const requiresOfficialNativeHome =
  process.env.E2E_NATIVE_PROVIDER_SWITCH_LIVE === "1";
const officialNativeHome = path.resolve(
  process.env.E2E_NATIVE_PROVIDER_SWITCH_OFFICIAL_HOME ?? os.homedir()
);

if (requiresOfficialNativeHome && !nativeTranscriptHome) {
  console.error(
    "E2E_NATIVE_PROVIDER_SWITCH_LIVE=1 requires --native-transcript-home " +
      "(or ORGII_NATIVE_TRANSCRIPT_HOME) so provider App proof cannot publish " +
      "into the disposable external-history home."
  );
  process.exit(1);
}
if (
  requiresOfficialNativeHome &&
  nativeTranscriptHome !== officialNativeHome
) {
  console.error(
    `Native provider App proof requires ${officialNativeHome}, got ${nativeTranscriptHome}.`
  );
  process.exit(1);
}

if (!fs.existsSync(appPath)) {
  console.error(`Instance app not found: ${appPath}`);
  process.exit(1);
}
fs.mkdirSync(dataHome, { recursive: true });
fs.mkdirSync(externalHistoryHome, { recursive: true });
if (nativeTranscriptHome) {
  fs.mkdirSync(nativeTranscriptHome, { recursive: true });
}

const instanceEnv = {
  ORGII_HOME: dataHome,
  ORGII_EXTERNAL_HISTORY_HOME: externalHistoryHome,
  ...(nativeTranscriptHome
    ? { ORGII_NATIVE_TRANSCRIPT_HOME: nativeTranscriptHome }
    : {}),
  ORGII_IDE_SERVER_PORT: String(profile.ideServerPort),
  ORGII_CLI_PROXY_PORT: String(profile.cliProxyPort),
  ORGII_DEEP_LINK_SCHEME: profile.authDeepLinkScheme,
};

if (process.platform === "win32") {
  const child = spawn(appPath, [], {
    cwd: rootDir,
    detached: true,
    env: { ...process.env, ...instanceEnv },
    stdio: "ignore",
    windowsHide: false,
  });
  child.unref();
  console.log(
    `[instance ${profile.id}] started ${appPath}\n` +
      `  ORGII_HOME=${dataHome}\n` +
      `  External history home=${externalHistoryHome}\n` +
      `  Native transcript home=${nativeTranscriptHome ?? "isolated"}\n` +
      `  IDE server=${profile.ideServerPort}, CLI proxy=${profile.cliProxyPort}`
  );
  process.exit(0);
}

const openArgs = ["-n"];
for (const [name, value] of Object.entries(instanceEnv)) {
  openArgs.push("--env", `${name}=${value}`);
}
openArgs.push(appPath);
const result = spawnSync("open", openArgs, { stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);

console.log(
  `[instance ${profile.id}] opened ${appPath}\n` +
    `  ORGII_HOME=${dataHome}\n` +
    `  External history home=${externalHistoryHome}\n` +
    `  Native transcript home=${nativeTranscriptHome ?? "isolated"}\n` +
    `  IDE server=${profile.ideServerPort}, CLI proxy=${profile.cliProxyPort}`
);
