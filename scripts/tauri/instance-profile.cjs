const path = require("path");
const os = require("os");

const PRIMARY_IDE_PORT = 13847;
const PRIMARY_PROXY_PORT = 17888;
const MAX_INSTANCE_ID = 99;

function parseInstanceId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 2 || id > MAX_INSTANCE_ID) {
    throw new Error(
      `--instance must be an integer from 2 through ${MAX_INSTANCE_ID}`
    );
  }
  return id;
}

function createInstanceProfile(value) {
  const id = parseInstanceId(value);
  const suffix = `instance${id}`;
  return {
    id,
    productName: `ORG2 Instance ${id}`,
    identifier: `org2ai.org2.${suffix}`,
    deepLinkSchemes: [`yorgai-${suffix}`, `orgii-${suffix}`],
    authDeepLinkScheme: `orgii-${suffix}`,
    ideServerPort: PRIMARY_IDE_PORT + id - 1,
    cliProxyPort: PRIMARY_PROXY_PORT + id - 1,
    dataHome: path.join(os.homedir(), `.orgii-${suffix}`),
  };
}

function createInstanceProfileFromIdeServerPort(value) {
  const port = Number(value);
  const instanceId = port - PRIMARY_IDE_PORT + 1;
  if (!Number.isInteger(port) || !Number.isInteger(instanceId)) {
    throw new Error(`IDE server port must be an integer, got ${value}`);
  }
  try {
    return createInstanceProfile(instanceId);
  } catch {
    throw new Error(
      `IDE server port ${port} must identify an instance from 2 through ${MAX_INSTANCE_ID} ` +
        `(${PRIMARY_IDE_PORT + 1}-${PRIMARY_IDE_PORT + MAX_INSTANCE_ID - 1})`
    );
  }
}

module.exports = {
  createInstanceProfile,
  createInstanceProfileFromIdeServerPort,
  parseInstanceId,
};
