const path = require("path");
const HtmlWebpackPlugin = require("html-webpack-plugin");

const createDesktopConfig = require("./config/webpack.config");

/**
 * Browser entry that reuses the desktop compiler, aliases, design tokens and
 * chunk strategy while keeping output and HTML independent from Tauri.
 */
module.exports = (env, argv) => {
  const config = createDesktopConfig(env, argv);
  const webTauriAdapter = path.resolve(
    __dirname,
    "src/web/platform/tauriUnavailable.cjs"
  );
  const port = Number.parseInt(
    process.env.WEBPACK_DEV_SERVER_PORT ?? process.env.PORT ?? "1999",
    10
  );

  config.entry = { web: "./src/web/index.tsx" };
  config.output = {
    ...config.output,
    path: path.resolve(__dirname, "build-web"),
  };
  config.cache = {
    ...config.cache,
    version: `${config.cache.version}-web`,
    buildDependencies: {
      ...config.cache.buildDependencies,
      config: [__filename, path.resolve(__dirname, "config/webpack.config.js")],
    },
  };
  config.resolve.alias = {
    "@src/engines/ChatPanel/runtime/sessionTranscriptPlatform$": path.resolve(
      __dirname,
      "src/web/platform/sessionTranscriptPlatform.ts"
    ),
    ...config.resolve.alias,
    "@tauri-apps/api/app$": webTauriAdapter,
    "@tauri-apps/api/core$": webTauriAdapter,
    "@tauri-apps/api/dpi$": webTauriAdapter,
    "@tauri-apps/api/event$": webTauriAdapter,
    "@tauri-apps/api/menu$": webTauriAdapter,
    "@tauri-apps/api/path$": webTauriAdapter,
    "@tauri-apps/api/webview$": webTauriAdapter,
    "@tauri-apps/api/webviewWindow$": webTauriAdapter,
    "@tauri-apps/api/window$": webTauriAdapter,
    "@tauri-apps/plugin-deep-link$": webTauriAdapter,
    "@tauri-apps/plugin-dialog$": webTauriAdapter,
    "@tauri-apps/plugin-fs$": webTauriAdapter,
    "@tauri-apps/plugin-notification$": webTauriAdapter,
    "@tauri-apps/plugin-opener$": webTauriAdapter,
    "@tauri-apps/plugin-process$": webTauriAdapter,
    "@tauri-apps/plugin-shell$": webTauriAdapter,
    "@tauri-apps/plugin-store$": webTauriAdapter,
    "@tauri-apps/plugin-updater$": webTauriAdapter,
  };
  config.plugins = [
    ...config.plugins.filter(
      (plugin) => !(plugin instanceof HtmlWebpackPlugin)
    ),
    new HtmlWebpackPlugin({
      template: "./public/web.html",
      chunks: ["web"],
      filename: "index.html",
      inject: "body",
    }),
  ];
  config.devServer = {
    ...config.devServer,
    port,
    client:
      config.devServer.client === false
        ? false
        : {
            ...config.devServer.client,
            webSocketURL: {
              ...config.devServer.client.webSocketURL,
              port,
            },
          },
  };

  return config;
};
