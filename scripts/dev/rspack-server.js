#!/usr/bin/env node

/**
 * ORG2 Rspack dev server — the default dev server on macOS
 * (`pnpm tauri:dev`; other platforms default to webpack-server.js, and
 * `--webpack` / ORGII_RSPACK=false opts back out on macOS).
 * Mirror of webpack-server.js against config/rspack.config.js. Emits the
 * same WEBPACK_STATUS/WEBPACK_PROGRESS structured lines so
 * scripts/dev/tauri.js can drive either server unchanged.
 * Standalone: `pnpm dev:frontend:rspack`. Same default port as the webpack
 * server (1998, tauri.conf.json devUrl).
 */

process.title = "ORG2 Rspack Dev";

process.env.HTTP_PROXY = "";
process.env.http_proxy = "";
process.env.HTTPS_PROXY = "";
process.env.https_proxy = "";
process.env.NO_PROXY = "127.0.0.1,localhost";

const path = require("path");
const { rspack } = require("@rspack/core");
const { RspackDevServer } = require("@rspack/dev-server");

const repoRoot = path.resolve(__dirname, "..", "..");
const config = require(path.join(repoRoot, "config", "rspack.config.js"))();

let compiler;
try {
  compiler = rspack(config);
} catch (error) {
  console.error("❌ Failed to create rspack compiler:", error.message);
  console.error(error);
  process.exit(1);
}

let isFirstCompile = true;
let compileStartTime = Date.now();

// Same structured progress protocol as webpack-server.js so the tauri.js
// status bar works for both servers.
new rspack.ProgressPlugin((percentage, message, ...details) => {
  const pct = Math.round(percentage * 100);
  // rspack passes non-string detail args (unlike webpack) — only strings
  // are printable.
  const detail =
    typeof details[0] === "string" ? ` ${details[0].slice(-60)}` : "";
  process.stdout.write(`WEBPACK_PROGRESS:${pct} ${message ?? ""}${detail}\n`);
}).apply(compiler);

compiler.hooks.compile.tap("ORGIIRspackDevServer", () => {
  compileStartTime = Date.now();
  if (!isFirstCompile) {
    process.stdout.write("WEBPACK_STATUS:recompiling\n");
  }
});

compiler.hooks.done.tap("ORGIIRspackDevServer", (stats) => {
  const hasErrors = stats.hasErrors();
  const hasWarnings = stats.hasWarnings();
  const ms = Date.now() - compileStartTime;

  if (hasErrors) {
    const errorOutput = stats.toString({
      all: false,
      errors: true,
      errorDetails: true,
      colors: false,
    });
    process.stderr.write(`\n${errorOutput}\n`);
  }

  if (isFirstCompile) {
    isFirstCompile = false;
    process.stdout.write(
      hasErrors
        ? "WEBPACK_STATUS:error\n"
        : `WEBPACK_STATUS:done_initial ${ms}ms\n`
    );
  } else {
    process.stdout.write(
      hasErrors
        ? "WEBPACK_STATUS:error\n"
        : hasWarnings
          ? `WEBPACK_STATUS:done_warnings ${ms}ms\n`
          : `WEBPACK_STATUS:done ${ms}ms\n`
    );
  }
});

// ORGII_RSPACK_LAZY=true (see config/rspack.config.js): @rspack/dev-server
// does not install the lazy-compilation trigger endpoint itself, so wire the
// middleware from @rspack/core manually. Without it the lazyCompilation
// option is silently inert and every chunk still compiles eagerly.
if (process.env.ORGII_RSPACK_LAZY === "true") {
  const { lazyCompilationMiddleware } = require("@rspack/core");
  const lazyMiddleware = lazyCompilationMiddleware(compiler);
  const userSetup = config.devServer.setupMiddlewares;
  config.devServer.setupMiddlewares = (middlewares, devServer) => {
    middlewares.unshift({
      name: "rspack-lazy-compilation",
      middleware: lazyMiddleware,
    });
    return userSetup ? userSetup(middlewares, devServer) : middlewares;
  };
}

const server = new RspackDevServer(config.devServer, compiler);

const shutdown = async (signal) => {
  console.log(`\n📡 Received ${signal}, shutting down...`);
  try {
    await server.stop();
    process.exit(0);
  } catch (error) {
    console.error("❌ Error during shutdown:", error.message);
    process.exit(1);
  }
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

server
  .start()
  .then(() => {
    console.log(
      `✨ ORG2 Rspack Dev Server: http://localhost:${config.devServer.port}`
    );
  })
  .catch((error) => {
    console.error("\n❌ Failed to start rspack dev server\n");
    console.error("Error:", error.message);
    process.exit(1);
  });
