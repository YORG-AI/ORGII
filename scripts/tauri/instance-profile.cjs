const path = require("path");
const os = require("os");

const PRIMARY_IDE_PORT = 13847;
const PRIMARY_PROXY_PORT = 17888;

function parseInstanceId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 2 || id > 99) {
    throw new Error("--instance must be an integer from 2 through 99");
  }
  return id;
}

function createInstanceProfile(value) {
  const id = parseInstanceId(value);
  const suffix = `instance${id}`;
  return {
    id,
    productName: `ORG2 Instance ${id}`,
    identifier: `yorg.orgii.${suffix}`,
    deepLinkSchemes: [`yorgai-${suffix}`, `orgii-${suffix}`],
    authDeepLinkScheme: `orgii-${suffix}`,
    ideServerPort: PRIMARY_IDE_PORT + id - 1,
    cliProxyPort: PRIMARY_PROXY_PORT + id - 1,
    dataHome: path.join(os.homedir(), `.orgii-${suffix}`),
  };
}

module.exports = { createInstanceProfile, parseInstanceId };
