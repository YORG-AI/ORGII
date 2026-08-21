const assert = require("node:assert/strict");
const test = require("node:test");

const createWebpackConfig = require("../../config/webpack.config.js");

function withEnv(overrides, fn) {
  const previous = {};
  for (const key of Object.keys(overrides)) {
    previous[key] = process.env[key];
    if (overrides[key] == null) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }

  try {
    return fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (previous[key] == null) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
}

function getDefinedValue(config, key) {
  const definePlugin = config.plugins.find(
    (plugin) => plugin.constructor?.name === "DefinePlugin"
  );
  return definePlugin?.definitions?.[key];
}

test("light dev disables webpack dev-server browser client", () => {
  const config = withEnv(
    {
      ORGII_LIGHT_DEV: "true",
      FAST_DEV: "true",
      DEV_SOURCEMAPS: "false",
      ORGII_RETRY_MAIN_SCRIPT_LOAD: "false",
    },
    () => createWebpackConfig({}, { mode: "development" })
  );

  assert.equal(config.devServer.hot, false);
  assert.equal(config.devServer.liveReload, false);
  assert.equal(config.devServer.client, false);

  const htmlPlugin = config.plugins.find(
    (plugin) => plugin.constructor?.name === "HtmlWebpackPlugin"
  );
  assert.equal(htmlPlugin?.userOptions?.inject, "body");
  assert.equal(htmlPlugin?.userOptions?.retryMainScriptLoad, false);
});

test("retrying main script loader disables static HTML injection in dev", () => {
  const config = withEnv(
    {
      ORGII_RETRY_MAIN_SCRIPT_LOAD: "true",
    },
    () => createWebpackConfig({}, { mode: "development" })
  );
  const htmlPlugin = config.plugins.find(
    (plugin) => plugin.constructor?.name === "HtmlWebpackPlugin"
  );
  assert.equal(htmlPlugin?.userOptions?.inject, false);
  assert.equal(htmlPlugin?.userOptions?.retryMainScriptLoad, true);
});

test("production keeps default HTML script injection", () => {
  const config = withEnv(
    {
      ORGII_RETRY_MAIN_SCRIPT_LOAD: "true",
    },
    () => createWebpackConfig({}, { mode: "production" })
  );
  const htmlPlugin = config.plugins.find(
    (plugin) => plugin.constructor?.name === "HtmlWebpackPlugin"
  );
  assert.equal(htmlPlugin?.userOptions?.inject, "body");
  assert.equal(htmlPlugin?.userOptions?.retryMainScriptLoad, false);
});

test("WebDriver production bundles enable the E2E-only Agent Org gate", () => {
  const config = withEnv(
    {
      ORGII_E2E: null,
      ORGII_AGENT_ORG_REDESIGN: null,
      WEBDRIVER: "1",
    },
    () => createWebpackConfig({}, { mode: "production" })
  );

  assert.equal(getDefinedValue(config, "process.env.ORGII_E2E"), '"1"');
  assert.equal(
    getDefinedValue(config, "process.env.ORGII_AGENT_ORG_REDESIGN"),
    '"1"'
  );
});

test("ordinary production bundles keep the Agent Org rollout disabled", () => {
  const config = withEnv(
    {
      ORGII_E2E: null,
      ORGII_AGENT_ORG_REDESIGN: null,
      WEBDRIVER: null,
    },
    () => createWebpackConfig({}, { mode: "production" })
  );

  assert.equal(getDefinedValue(config, "process.env.ORGII_E2E"), '"0"');
  assert.equal(
    getDefinedValue(config, "process.env.ORGII_AGENT_ORG_REDESIGN"),
    '"0"'
  );
});
