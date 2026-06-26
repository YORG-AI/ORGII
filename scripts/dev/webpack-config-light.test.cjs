const assert = require("node:assert/strict");
const test = require("node:test");

const createWebpackConfig = require("../../webpack.config.js");

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
