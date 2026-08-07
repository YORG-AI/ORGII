#!/usr/bin/env node

const { spawnSync } = require("child_process");
const fs = require("fs");
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

if (!fs.existsSync(appPath)) {
  console.error(`Instance app not found: ${appPath}`);
  process.exit(1);
}
fs.mkdirSync(dataHome, { recursive: true });

const instanceEnv = {
  ORGII_HOME: dataHome,
  ORGII_IDE_SERVER_PORT: String(profile.ideServerPort),
  ORGII_CLI_PROXY_PORT: String(profile.cliProxyPort),
};
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
    `  IDE server=${profile.ideServerPort}, CLI proxy=${profile.cliProxyPort}`
);
