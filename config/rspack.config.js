// Rspack dev-server config — the default dev bundler on macOS; other
// platforms default to config/webpack.config.js (see
// createFrontendScriptName in scripts/dev/tauri-dev-processes.cjs).
// Dev-only: production builds stay on webpack. Launch via `pnpm tauri:dev`
// (macOS), `pnpm tauri:dev:rspack`, or `pnpm dev:frontend:rspack`.
// Measured vs the webpack dev server (2026-09-01, macOS, footprint method):
// idle 1.65 GB vs 2.4 GB, warm-start peak 2.1 GB vs 3.6 GB, HMR rebuild
// ~0.6 s vs ~3 s, cold compile 10.7 s with no persistent cache.
// Deliberately omits: the production branch, the Linux/WebKitGTK eager-App +
// retry-loader mode (Linux dev should keep the webpack server for now), and
// a persistent cache (rspack's is still experimental; default memory cache).
const path = require("path");
const rspack = require("@rspack/core");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const {
  ReactRefreshRspackPlugin: ReactRefreshPlugin,
} = require("@rspack/plugin-react-refresh");

const repoRoot = path.resolve(__dirname, "..");

module.exports = () => {
  const devServerPort = Number.parseInt(
    process.env.WEBPACK_DEV_SERVER_PORT ?? process.env.PORT ?? "1998",
    10
  );

  // Mirror dotenv-webpack(systemvars) for the env keys src actually reads.
  const envKeys = [
    "TZ",
    "HOME",
    "REACT_APP_LOCALURL",
    "REACT_APP_SUPABASE_URL",
    "REACT_APP_SUPABASE_PUBLISHABLE_KEY",
    "REACT_APP_SUPABASE_OAUTH_SCOPES",
    "REACT_APP_REDIRECT_ON_500",
    "REACT_APP_MARKETPLACE_URL",
    "REACT_APP_HOSTED_LOGIN_ENABLED",
    "REACT_APP_CANVAS_SHARE_VIEWER_URL",
    "REACT_APP_CANVAS_SHARE_API_URL",
    "REACT_APP_AGENT_URL",
  ];
  const envDefinitions = Object.fromEntries(
    envKeys.map((k) => [
      `process.env.${k}`,
      process.env[k] === undefined ? "undefined" : JSON.stringify(process.env[k]),
    ])
  );

  const swcLoader = (syntax, jsxOrTsx) => ({
    loader: "builtin:swc-loader",
    options: {
      jsc: {
        target: "es2020",
        parser:
          syntax === "typescript"
            ? { syntax: "typescript", tsx: jsxOrTsx }
            : { syntax: "ecmascript", jsx: jsxOrTsx },
        transform: jsxOrTsx
          ? {
              react: {
                runtime: "automatic",
                refresh: true,
                development: true,
              },
            }
          : undefined,
      },
    },
  });

  return {
    mode: "development",
    context: repoRoot,
    entry: {
      main: "./src/index.tsx",
    },
    output: {
      path: path.resolve(repoRoot, "build-rspack"),
      publicPath: "/",
      filename: "[name].js",
      chunkFilename: "[name].js",
      clean: true,
    },
    module: {
      parser: {
        javascript: {
          exportsPresence: "warn",
        },
      },
      rules: [
        {
          test: /[\\/]src[\\/]icons\.ts$/,
          sideEffects: false,
        },
        {
          test: /\.css$/,
          use: ["style-loader", "css-loader"],
        },
        {
          test: /\.scss$/,
          use: [
            "style-loader",
            "css-loader",
            {
              loader: "postcss-loader",
              options: {
                postcssOptions: {
                  config: path.resolve(repoRoot, "config/postcss.config.js"),
                },
              },
            },
            {
              loader: "sass-loader",
              options: {
                // Same native compiler setup as webpack.config.js: shared
                // sass-embedded process via the modern-compiler API.
                implementation: require("sass-embedded"),
                api: "modern-compiler",
                sassOptions: {
                  quietDeps: true,
                  silenceDeprecations: ["import"],
                },
              },
            },
          ],
        },
        {
          test: /\.jsx$/,
          exclude: /node_modules/,
          use: swcLoader("ecmascript", true),
        },
        {
          test: /\.js$/,
          exclude: /node_modules/,
          resourceQuery: { not: [/raw/] },
          use: swcLoader("ecmascript", false),
        },
        {
          test: /\.tsx$/,
          exclude: /node_modules/,
          use: swcLoader("typescript", true),
        },
        {
          test: /\.ts$/,
          exclude: /node_modules/,
          use: swcLoader("typescript", false),
        },
        {
          test: /\.(mp4|webm)$/i,
          type: "asset/resource",
          generator: { filename: "videos/[name].[contenthash:8][ext]" },
        },
        {
          test: /\.(png|jpe?g|gif|webp)$/i,
          type: "asset",
          parser: { dataUrlCondition: { maxSize: 8 * 1024 } },
          generator: { filename: "images/[name].[contenthash:8][ext]" },
        },
        {
          test: /\.(woff2?|ttf|otf)$/i,
          type: "asset/resource",
          generator: { filename: "fonts/[name].[contenthash:8][ext]" },
        },
        {
          test: /\.svg$/,
          resourceQuery: /url/,
          type: "asset/resource",
          generator: { filename: "images/[name].[contenthash:8][ext]" },
        },
        {
          test: /\.svg$/,
          resourceQuery: { not: [/url/] },
          use: [
            {
              loader: "@svgr/webpack",
              options: {
                configFile: path.resolve(repoRoot, "config/svgr.json"),
                svgo: true,
                svgoConfig: {
                  plugins: [
                    {
                      name: "preset-default",
                      params: { overrides: { removeViewBox: false } },
                    },
                  ],
                },
              },
            },
          ],
        },
        {
          test: /node_modules\/@webcontainer\/api/,
          sideEffects: false,
        },
        {
          test: /\.glsl$/,
          type: "asset/source",
        },
        {
          test: /\.md$/,
          type: "asset/source",
        },
        {
          test: /\.js$/,
          resourceQuery: /raw/,
          type: "asset/source",
        },
      ],
    },
    resolve: {
      extensions: [".tsx", ".ts", ".js", ".mjs"],
      modules: ["node_modules"],
      alias: {
        "@": path.resolve(repoRoot),
        "@src": path.resolve(repoRoot, "src/"),
        "@api": path.resolve(repoRoot, "src/api/"),
        "@common": path.resolve(repoRoot, "src/common/"),
        "@page": path.resolve(repoRoot, "src/page/"),
        "@assets": path.resolve(repoRoot, "src/assets/"),
        "@codemirror/commands": path.dirname(
          require.resolve("@codemirror/commands")
        ),
        "@codemirror/language": path.dirname(
          require.resolve("@codemirror/language")
        ),
        "@codemirror/state": path.dirname(require.resolve("@codemirror/state")),
        "@codemirror/view": path.dirname(require.resolve("@codemirror/view")),
        "@a2ui/web_core/v0_9": path.join(
          path.dirname(path.dirname(require.resolve("@a2ui/web_core"))),
          "v0_9"
        ),
        "lowlight/lib/core": (() => {
          const fs = require("fs");
          const pnpmDir = path.resolve(repoRoot, "node_modules/.pnpm");
          try {
            const dir = fs
              .readdirSync(pnpmDir)
              .find((d) => d.startsWith("lowlight@1."));
            if (dir)
              return path.join(
                pnpmDir,
                dir,
                "node_modules/lowlight/lib/core.js"
              );
          } catch (_ignored) {}
          return path.resolve(
            repoRoot,
            "node_modules/react-syntax-highlighter/node_modules/lowlight/lib/core.js"
          );
        })(),
      },
      fallback: {
        process: require.resolve("process/browser"),
        fs: false,
        crypto: false,
        path: false,
      },
    },
    // EXPERIMENTS (opt-in via env, defaults unchanged; both are top-level
    // options in rspack 2.x, not `experiments.*`):
    // ORGII_RSPACK_CACHE=persistent — persistent build cache for warm starts.
    // ORGII_RSPACK_LAZY=true — compile dynamic-import chunks only when the
    // webview actually requests them (875+ import() boundaries in src).
    ...(process.env.ORGII_RSPACK_CACHE === "persistent"
      ? {
          cache: {
            type: "persistent",
            buildDependencies: [__filename],
            version: "dev-1",
          },
        }
      : {}),
    ...(process.env.ORGII_RSPACK_LAZY === "true"
      ? { lazyCompilation: { imports: true, entries: false } }
      : {}),
    optimization: {
      minimize: false,
      // Same dev dedup group as webpack.config.js: hoist modules shared by
      // >= 2 async chunks so CodeMirror/xterm/Prism aren't duplicated per chunk.
      splitChunks: {
        chunks: "async",
        minSize: 0,
        minChunks: 2,
        cacheGroups: {
          default: false,
          defaultVendors: false,
          shared: {
            minChunks: 2,
            reuseExistingChunk: true,
            priority: 10,
          },
        },
      },
      runtimeChunk: false,
      moduleIds: "named",
    },
    plugins: [
      new HtmlWebpackPlugin({
        template: "./public/index.html",
        chunks: ["main"],
        filename: "index.html",
        inject: "body",
        retryMainScriptLoad: false,
      }),
      new ReactRefreshPlugin({ overlay: false }),
      new rspack.DefinePlugin({
        "process.env.NODE_ENV": JSON.stringify("development"),
        "process.env.ORGII_DEV_EAGER_APP": JSON.stringify("false"),
        "process.env.ORGII_IDE_SERVER_PORT": JSON.stringify(
          process.env.ORGII_IDE_SERVER_PORT ?? "13847"
        ),
        "process.env.ORGII_DEEP_LINK_SCHEME": JSON.stringify(
          process.env.ORGII_DEEP_LINK_SCHEME ?? "orgii"
        ),
        "process.env.E2E_BASE_URL": JSON.stringify(
          process.env.E2E_BASE_URL ??
            `http://127.0.0.1:${process.env.ORGII_IDE_SERVER_PORT ?? "13847"}`
        ),
        ...envDefinitions,
      }),
    ],
    devServer: {
      port: devServerPort,
      hot: true,
      liveReload: true,
      historyApiFallback: true,
      static: {
        directory: path.resolve(repoRoot, "public"),
        watch: false,
      },
      client: {
        overlay: false,
        reconnect: 5,
        webSocketURL: {
          hostname: "localhost",
          pathname: "/ws",
          port: devServerPort,
        },
      },
      open: false,
      headers: {
        "Cross-Origin-Embedder-Policy": "credentialless",
        "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
        "Cross-Origin-Resource-Policy": "cross-origin",
      },
      proxy: [
        {
          context: ["/tasktracker-api"],
          target: "http://127.0.0.1:8002",
          changeOrigin: true,
          secure: false,
          pathRewrite: { "^/tasktracker-api": "" },
        },
      ],
    },
    performance: { hints: false },
    stats: {
      all: false,
      errors: true,
      warnings: true,
      timings: true,
      colors: true,
    },
    devtool: "eval-cheap-module-source-map",
  };
};
