const fs = require("fs");
const webpack = require("webpack");
const path = require("path");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const ReactRefreshWebpackPlugin = require("@pmmmwh/react-refresh-webpack-plugin");
const Dotenv = require("dotenv-webpack");
const MiniCssExtractPlugin = require("mini-css-extract-plugin");
const CopyWebpackPlugin = require("copy-webpack-plugin");
const TerserPlugin = require("terser-webpack-plugin");
const CssMinimizerPlugin = require("css-minimizer-webpack-plugin");
const { EsbuildPlugin } = require("esbuild-loader");
const { CleanWebpackPlugin } = require("clean-webpack-plugin");

// ForkTsCheckerWebpackPlugin removed - causes memory issues with large codebase
// Type checking handled by IDE; transpileOnly: true provides fast builds

module.exports = (env, argv) => {
  const isProduction = argv.mode === "production";

  const isLightDev = !isProduction && process.env.ORGII_LIGHT_DEV === "true";

  // Development build mode:
  // - Default: SWC (fast builds ~3-5s + React Fast Refresh for state-preserving HMR)
  // - FAST_DEV=true: esbuild (fastest ~2s, but full app remount on changes)
  // - ORGII_LIGHT_DEV=true: esbuild, no HMR, no source maps
  //
  // SWC is a Rust-based compiler that's nearly as fast as esbuild but supports
  // React Fast Refresh. esbuild is faster but can't support Fast Refresh.
  const useFastDev =
    !isProduction && (isLightDev || process.env.FAST_DEV === "true");
  const useDevSourceMaps =
    !isProduction && !isLightDev && process.env.DEV_SOURCEMAPS !== "false";
  const retryMainScriptLoad =
    !isProduction &&
    (process.env.ORGII_RETRY_MAIN_SCRIPT_LOAD === "true" ||
      (process.env.ORGII_RETRY_MAIN_SCRIPT_LOAD !== "false" &&
        process.platform === "linux"));

  // FAST_PROD=true: use esbuild for transpilation + minification in production.
  // Saves ~30-40s vs the SWC+Terser path. Trades some dead-code elimination
  // depth for speed. Intended for local fast .app builds, not release builds.
  const useFastProd = isProduction && process.env.FAST_PROD === "true";

  const isE2E = process.env.ORGII_E2E === "1";
  const devServerPort = Number.parseInt(
    process.env.WEBPACK_DEV_SERVER_PORT ?? process.env.PORT ?? "1998",
    10
  );

  return {
    entry: {
      main: "./src/index.tsx",
    },
    output: {
      path: path.resolve(__dirname, "build"),
      // IMPORTANT: publicPath must be "/" to ensure assets load from root
      // Without this, deep routes like /orgii/marketplace/callback cause 404s
      publicPath: "/",
      // IMPORTANT: Use stable names in development to prevent 404s during hot reload
      // Content hashes change on every rebuild, causing chunk loading failures
      filename: isProduction ? "[name].[contenthash].js" : "[name].js",
      chunkFilename: isProduction ? "[name].[contenthash].js" : "[name].js",
      clean: true,
    },
    cache: {
      type: "filesystem",
      // Version the cache for faster invalidation
      version: `${isProduction ? "prod" : "dev"}-6`,
      buildDependencies: {
        config: [__filename],
      },
      // Don't compress - avoids sass serialization issues
      compression: false,
    },
    // Snapshot: use timestamps for node_modules instead of content hashing.
    // node_modules rarely change during a dev session; timestamp checks are much faster.
    snapshot: {
      managedPaths: [path.resolve(__dirname, "node_modules")],
      immutablePaths: [],
      module: {
        timestamp: true,
        hash: false,
      },
      resolve: {
        timestamp: true,
        hash: false,
      },
    },

    module: {
      parser: {
        javascript: {
          exportsPresence: "warn",
        },
      },
      rules: [
        {
          test: /\.css$/,
          use: [
            isProduction ? MiniCssExtractPlugin.loader : "style-loader",
            "css-loader",
          ],
        },
        {
          test: /\.scss$/,
          use: [
            isProduction ? MiniCssExtractPlugin.loader : "style-loader",
            "css-loader",
            "postcss-loader",
            {
              loader: "sass-loader",
              options: {
                // Use modern API to eliminate deprecation warnings (80+ warnings slowing builds)
                api: "modern",
                sassOptions: {
                  // Silence deprecation warnings for faster compilation
                  quietDeps: true,
                  silenceDeprecations: ["legacy-js-api", "import"],
                },
              },
            },
          ],
        },
        {
          test: /\.jsx$/,
          exclude: /node_modules/,
          use: useFastDev
            ? {
                loader: "esbuild-loader",
                options: {
                  loader: "jsx",
                  target: "es2018",
                  jsx: "automatic",
                },
              }
            : {
                // SWC: Fast Rust-based compiler with React Fast Refresh support
                loader: "swc-loader",
                options: {
                  jsc: {
                    target: "es2020",
                    parser: { syntax: "ecmascript", jsx: true },
                    transform: {
                      react: {
                        runtime: "automatic",
                        refresh: !isProduction,
                      },
                    },
                  },
                },
              },
        },
        {
          test: /\.js$/,
          exclude: /node_modules/,
          use:
            useFastDev || useFastProd
              ? {
                  loader: "esbuild-loader",
                  options: {
                    loader: "js",
                    target: "es2020",
                  },
                }
              : {
                  loader: "swc-loader",
                  options: {
                    jsc: {
                      target: "es2020",
                      parser: { syntax: "ecmascript" },
                    },
                  },
                },
        },
        {
          test: /\.tsx$/,
          exclude: /node_modules/,
          use:
            useFastDev || useFastProd
              ? {
                  // esbuild-loader: fastest but no React Fast Refresh
                  loader: "esbuild-loader",
                  options: {
                    loader: "tsx",
                    target: "es2020",
                    jsx: "automatic",
                  },
                }
              : {
                  // SWC: Fast Rust-based compiler with React Fast Refresh support
                  loader: "swc-loader",
                  options: {
                    jsc: {
                      target: "es2020",
                      parser: { syntax: "typescript", tsx: true },
                      transform: {
                        react: {
                          runtime: "automatic",
                          refresh: !isProduction,
                        },
                      },
                    },
                  },
                },
        },
        {
          test: /\.ts$/,
          exclude: /node_modules/,
          use:
            useFastDev || useFastProd
              ? {
                  // IMPORTANT: .ts must be parsed as TS (not TSX) to avoid JSX ambiguity
                  loader: "esbuild-loader",
                  options: {
                    loader: "ts",
                    target: "es2020",
                  },
                }
              : {
                  loader: "swc-loader",
                  options: {
                    jsc: {
                      target: "es2020",
                      parser: { syntax: "typescript", tsx: false },
                    },
                  },
                },
        },
        {
          test: /\.(mp4|webm)$/i,
          type: "asset/resource",
          generator: {
            filename: "videos/[name].[contenthash:8][ext]",
          },
        },
        {
          // Use webpack 5 asset modules for better performance
          // Images smaller than 8KB will be inlined as data URLs
          test: /\.(png|jpe?g|gif|webp)$/i,
          type: "asset",
          parser: {
            dataUrlCondition: {
              maxSize: 8 * 1024, // 8KB threshold for inlining
            },
          },
          generator: {
            filename: "images/[name].[contenthash:8][ext]",
          },
        },
        {
          test: /\.(woff2?|ttf|otf)$/i,
          type: "asset/resource",
          generator: {
            filename: "fonts/[name].[contenthash:8][ext]",
          },
        },
        {
          // SVGs with ?url query - return URL instead of React component (for <img src>)
          test: /\.svg$/,
          resourceQuery: /url/,
          type: "asset/resource",
          generator: {
            filename: "images/[name].[contenthash:8][ext]",
          },
        },
        {
          // Regular SVGs - convert to React components with @svgr
          test: /\.svg$/,
          resourceQuery: { not: [/url/] },
          use: [
            {
              loader: "@svgr/webpack",
              options: {
                svgo: true,
                svgoConfig: {
                  plugins: [
                    {
                      name: "preset-default",
                      params: {
                        overrides: {
                          removeViewBox: false, // Keep viewBox for proper scaling
                        },
                      },
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
          // GLSL shaders - load as raw text for WebGL
          test: /\.glsl$/,
          use: "raw-loader",
        },
        {
          // Markdown files - load as raw text strings
          test: /\.md$/,
          type: "asset/source",
        },
      ],
    },
    resolve: {
      extensions: [".tsx", ".ts", ".js", ".mjs"],
      // Only resolve from node_modules. src/ paths are handled by aliases (@src, etc.)
      // Having src in modules causes extra filesystem lookups for every bare import.
      modules: ["node_modules"],
      alias: {
        "@": path.resolve(__dirname),
        "@src": path.resolve(__dirname, "src/"),
        "@api": path.resolve(__dirname, "src/api/"),
        "@common": path.resolve(__dirname, "src/common/"),
        "@page": path.resolve(__dirname, "src/page/"),
        "@assets": path.resolve(__dirname, "src/assets/"),
        "@codemirror/commands": path.dirname(
          require.resolve("@codemirror/commands")
        ),
        "@codemirror/language": path.dirname(
          require.resolve("@codemirror/language")
        ),
        "@codemirror/state": path.dirname(require.resolve("@codemirror/state")),
        "@codemirror/view": path.dirname(require.resolve("@codemirror/view")),
        // @a2ui/web_core exports ./v0_9 only under "default" condition, not "import"/"browser".
        // Webpack's package exports resolution omits "default"-only exports, so alias directly.
        // Point at the DIRECTORY (not index.js): webpack alias does prefix matching, so the bare
        // import resolves via directory-index (src/v0_9/index.js) while subpath imports like
        // "@a2ui/web_core/v0_9/basic_catalog" resolve to src/v0_9/basic_catalog (its index.js).
        // The "." entry resolves to .../src/v0_8/index.js; walk up to src/ then into v0_9 so this
        // stays correct under pnpm's symlinked store (matches the @codemirror/* pattern above).
        "@a2ui/web_core/v0_9": path.join(
          path.dirname(path.dirname(require.resolve("@a2ui/web_core"))),
          "v0_9"
        ),
        // react-syntax-highlighter expects the v1 lowlight lib/core.js entry.
        // Resolve that nested dependency explicitly from the pnpm store when needed.
        "lowlight/lib/core": (() => {
          const fs = require("fs");
          const pnpmDir = path.resolve(__dirname, "node_modules/.pnpm");
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
            __dirname,
            "node_modules/react-syntax-highlighter/node_modules/lowlight/lib/core.js"
          );
        })(),
      },
      fallback: {
        process: require.resolve("process/browser"),
        fs: false,
        // sql.js requires crypto but doesn't actually use it in browser
        crypto: false,
        path: false,
      },
    },
    optimization: {
      minimize: isProduction,
      minimizer: isProduction
        ? useFastProd
          ? [
              // FAST_PROD: esbuild minifier — ~10× faster than Terser, saves ~30s locally.
              // Slightly less aggressive dead-code elimination but output is production-safe.
              new EsbuildPlugin({
                target: "es2020",
                css: true,
                keepNames: true,
                drop: ["console", "debugger"],
              }),
            ]
          : [
              new TerserPlugin({
                parallel: true,
                terserOptions: {
                  compress: {
                    drop_console: true,
                    drop_debugger: true,
                    pure_funcs: [
                      "console.log",
                      "console.info",
                      "console.debug",
                      "console.trace",
                    ],
                    passes: 1,
                    dead_code: true,
                  },
                  mangle: {
                    keep_classnames: true,
                    keep_fnames: true,
                  },
                  keep_classnames: true,
                  keep_fnames: true,
                  output: {
                    comments: false,
                    ascii_only: true,
                  },
                },
                extractComments: false,
              }),
              new CssMinimizerPlugin(),
            ]
        : [],
      // In dev, skip expensive per-module regex splitting and runtime chunk extraction.
      // Only apply granular code splitting in production for caching benefits.
      ...(isProduction
        ? {
            splitChunks: {
              chunks: "all",
              maxInitialRequests: 25,
              minSize: 20000,
              cacheGroups: {
                vendor: {
                  test: /[\\/]node_modules[\\/]/,
                  name(module) {
                    const packageName = module.context.match(
                      /[\\/]node_modules[\\/](.*?)([\\/]|$)/
                    )?.[1];
                    const largePackages = [
                      "react-dom",
                      "lodash",
                      "framer-motion",
                    ];
                    if (
                      largePackages.some((pkg) => packageName?.startsWith(pkg))
                    ) {
                      return `vendor.${packageName.replace("@", "")}`;
                    }
                    return "vendors";
                  },
                  chunks: "all",
                  priority: 10,
                },
                common: {
                  minChunks: 2,
                  priority: 5,
                  reuseExistingChunk: true,
                },
              },
            },
            runtimeChunk: "single",
          }
        : {
            splitChunks: false,
            runtimeChunk: false,
          }),
      moduleIds: isProduction ? "deterministic" : "named",
    },
    plugins: [
      // CleanWebpackPlugin: only needed for production builds.
      // Dev server uses in-memory FS; output.clean handles the rest.
      isProduction && new CleanWebpackPlugin(),
      // Main app HTML
      new HtmlWebpackPlugin({
        template: "./public/index.html",
        chunks: ["main"],
        filename: "index.html",
        // Linux WebKitGTK can internally fail a static <script src="/main.js">
        // load even after the dev server is ready; a failed script is not
        // retried, so Linux dev uses the retrying external loader below.
        inject: retryMainScriptLoad ? false : "body",
        retryMainScriptLoad,
      }),
      // NOTE: HotModuleReplacementPlugin is automatically added by webpack-dev-server when hot: true
      // ReactRefreshWebpackPlugin works with SWC's refresh: true option to enable
      // state-preserving hot reload. Only enabled when not using esbuild/light mode.
      !isProduction &&
        !useFastDev &&
        !isLightDev &&
        new ReactRefreshWebpackPlugin({ overlay: false }),
      new Dotenv({
        systemvars: true,
        silent: !fs.existsSync(path.resolve(__dirname, ".env")),
      }),
      isProduction &&
        new MiniCssExtractPlugin({
          filename: "[name].[contenthash].css",
          chunkFilename: "[id].[contenthash].css",
          ignoreOrder: true,
        }),
      new webpack.DefinePlugin({
        "process.env.NODE_ENV": JSON.stringify(argv.mode),
        "process.env.E2E_BASE_URL": JSON.stringify(
          process.env.E2E_BASE_URL ?? "http://127.0.0.1:13847"
        ),
      }),
      // CopyWebpackPlugin: only needed for production.
      // In dev, static directory serves public/ files directly.
      isProduction &&
        new CopyWebpackPlugin({
          patterns: [{ from: "public/**/*.css", to: "[name][ext]" }],
        }),
      // ForkTsCheckerWebpackPlugin disabled - causes memory issues with large codebase
      // Type checking is handled by IDE instead. transpileOnly: true provides fast builds.
    ].filter(Boolean),
    devServer: {
      port: devServerPort,
      hot: !isLightDev,
      // Light dev avoids the webpack-dev-server browser client entirely.
      // WebKitGTK can trip internal loader errors around the injected
      // liveReload websocket path, and Tauri dev does not need it here.
      liveReload: !isLightDev,
      historyApiFallback: true,
      // Disable static file watching to prevent full page reloads during HMR.
      // Default behavior watches public/ directory, which can race with HMR
      // updates and trigger unnecessary index.html reloads.
      static: {
        directory: path.resolve(__dirname, "public"),
        watch: false,
      },
      client: isLightDev
        ? false
        : {
            overlay: false,
            // Reconnect settings for better HMR recovery
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
      proxy: {
        // TaskTracker API proxy - avoids CORS issues with localhost:8002
        "/tasktracker-api": {
          target: "http://127.0.0.1:8002",
          changeOrigin: true,
          secure: false,
          pathRewrite: { "^/tasktracker-api": "" },
        },
      },
    },
    ignoreWarnings: [
      {
        module: /keepalive-for-react/,
        message: /export 'Activity'/,
      },
    ],
    performance: {
      hints: false,
    },
    stats: {
      all: false,
      errors: true,
      warnings: true,
      timings: true,
      version: false, // Skip version check for faster startup
      builtAt: false, // Skip timestamp for faster startup
      modules: false, // Skip module list for faster startup
      colors: true,
      // Only show minimal info in dev mode
      preset: isProduction ? "normal" : "minimal",
    },
    // eval-cheap-module-source-map maps to original lines via loaders.
    // Light dev disables source maps to reduce renderer and compiler memory.
    devtool: useDevSourceMaps ? "eval-cheap-module-source-map" : false,
  };
};
