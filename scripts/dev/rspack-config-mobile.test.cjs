const assert = require("node:assert/strict");
const test = require("node:test");

const createRspackConfig = require("../../config/rspack.config.js");

test("rspack dev server exposes the mobile remote entry and rewrite", () => {
  const config = createRspackConfig();

  assert.equal(config.entry.mobile, "./src/mobileRemoteEntry.tsx");

  const htmlPlugins = config.plugins.filter(
    (plugin) => plugin.constructor?.name === "HtmlWebpackPlugin"
  );
  const mobileHtml = htmlPlugins.find(
    (plugin) => plugin.userOptions?.filename === "mobile.html"
  );

  assert.ok(mobileHtml, "expected HtmlWebpackPlugin for mobile.html");
  assert.deepEqual(mobileHtml.userOptions.chunks, ["mobile"]);
  assert.equal(mobileHtml.userOptions.inject, "body");

  assert.deepEqual(config.devServer.historyApiFallback, {
    rewrites: [{ from: /^\/orgii\/mobile(?:\/.*)?$/, to: "/mobile.html" }],
  });
});
