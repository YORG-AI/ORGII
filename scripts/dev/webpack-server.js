#!/usr/bin/env node

/**
 * ORG2 Development Server
 *
 * Custom webpack-dev-server wrapper with branded process name
 * This makes the process appear as "ORG2 Dev" in Activity Monitor
 * instead of generic "node"
 */

// ============================================
// Set Process Title FIRST (before any imports)
// ============================================
process.title = "ORG2 Dev";

// ============================================
// Environment Configuration
// ============================================
process.env.HTTP_PROXY = "";
process.env.http_proxy = "";
process.env.HTTPS_PROXY = "";
process.env.https_proxy = "";
process.env.NO_PROXY = "127.0.0.1,localhost";

// Check for slow dev mode
const isSlowMode =
  process.argv.includes("--slow") || process.env.SLOW_DEV === "true";

// ============================================
// Imports
// ============================================
const webpack = require("webpack");
const WebpackDevServer = require("webpack-dev-server");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..", "..");
const webpackConfigPath = path.join(repoRoot, "webpack.config.js");

// ============================================
// Load Webpack Configuration
// ============================================
let configFunction;
try {
  configFunction = require(webpackConfigPath);
} catch (error) {
  console.error("❌ Failed to load webpack config:", error.message);
  process.exit(1);
}

// ============================================
// Apply Environment-Specific Settings
// ============================================
if (isSlowMode) {
  console.log("🐢 Slow dev mode enabled (SLOW_DEV=true)");
}

// Call webpack config function with proper arguments
const env = {};
const argv = { mode: "development" };
let config;

try {
  config = configFunction(env, argv);

  // Ensure mode is explicitly set in config
  config.mode = "development";

  // Fix DefinePlugin conflict by ensuring NODE_ENV matches mode
  const definePlugin = config.plugins.find(
    (plugin) => plugin.constructor.name === "DefinePlugin"
  );
  if (definePlugin) {
    definePlugin.definitions["process.env.NODE_ENV"] =
      JSON.stringify("development");
  }

  // Reduce infrastructure logging for faster startup
  config.infrastructureLogging = {
    level: "warn", // Only show warnings and errors
    debug: false,
  };
} catch (error) {
  console.error("❌ Failed to generate webpack config:", error.message);
  process.exit(1);
}

// ============================================
// Suppress webpack-dev-server built-in progress (we provide our own)
// ============================================
if (config.devServer) {
  if (config.devServer.client !== false) {
    config.devServer.client = {
      ...(config.devServer.client || {}),
      progress: false,
    };
  }
}

// ============================================
// Create Webpack Compiler
// ============================================
let compiler;
try {
  compiler = webpack(config);

  // Emit structured progress so the parent process can render a status bar
  new webpack.ProgressPlugin((percentage, message, ...details) => {
    const pct = Math.round(percentage * 100);
    const detail = details[0] ? ` ${details[0].slice(-60)}` : "";
    process.stdout.write(`WEBPACK_PROGRESS:${pct} ${message}${detail}\n`);
  }).apply(compiler);

  // Add compiler hooks for better feedback
  let isFirstCompile = true;
  let compileStartTime = Date.now();

  compiler.hooks.compile.tap("ORGIIDevServer", () => {
    compileStartTime = Date.now();
    if (!isFirstCompile) {
      process.stdout.write("WEBPACK_STATUS:recompiling\n");
    }
  });

  compiler.hooks.done.tap("ORGIIDevServer", (stats) => {
    const hasErrors = stats.hasErrors();
    const hasWarnings = stats.hasWarnings();
    const ms = Date.now() - compileStartTime;

    if (hasErrors) {
      // Print the full error details so they appear in the terminal scroll
      const errorOutput = stats.toString({
        all: false,
        errors: true,
        errorDetails: true,
        colors: true,
      });
      process.stderr.write(`\n${errorOutput}\n`);
    }

    if (isFirstCompile) {
      isFirstCompile = false;
      if (!hasErrors) {
        process.stdout.write(`WEBPACK_STATUS:done_initial ${ms}ms\n`);
      } else {
        process.stdout.write("WEBPACK_STATUS:error\n");
      }
    } else {
      if (hasErrors) {
        process.stdout.write("WEBPACK_STATUS:error\n");
      } else if (hasWarnings) {
        process.stdout.write(`WEBPACK_STATUS:done_warnings ${ms}ms\n`);
      } else {
        process.stdout.write(`WEBPACK_STATUS:done ${ms}ms\n`);
      }
    }
  });

  // Suppress progress messages for cleaner output
  compiler.hooks.infrastructureLog.tap("ORGIIDevServer", (name, type, args) => {
    // Suppress verbose infrastructure logs
    if (type === "log" && args[0]?.includes?.("webpack")) {
      return false;
    }
  });
} catch (error) {
  console.error("❌ Failed to create webpack compiler:", error.message);
  console.error(error);
  process.exit(1);
}

// ============================================
// Configure Dev Server Options
// ============================================
function shouldLogDevRequest(url = "") {
  if (process.env.ORGII_DEV_STARTUP_DEBUG !== "true") {
    return false;
  }

  return (
    url === "/" ||
    url.startsWith("/main.js") ||
    url.startsWith("/index.html") ||
    url.startsWith("/ws") ||
    url.includes(".hot-update.") ||
    url.includes("webpack")
  );
}

const devServerOptions = {
  ...config.devServer,
  open: false, // Don't auto-open browser
  setupMiddlewares: (middlewares, devServer) => {
    middlewares.unshift({
      name: "orgii-dev-request-diagnostics",
      middleware: (req, res, next) => {
        if (shouldLogDevRequest(req.url)) {
          const startedAt = Date.now();
          res.on("finish", () => {
            const ua = String(req.headers["user-agent"] || "")
              .replace(/\s+/g, " ")
              .slice(0, 120);
            process.stdout.write(
              `[WDS_REQUEST] ${req.method} ${req.url} -> ${res.statusCode} ${Date.now() - startedAt}ms ua="${ua}"\n`
            );
          });
        }
        next();
      },
    });

    if (typeof config.devServer?.setupMiddlewares === "function") {
      return config.devServer.setupMiddlewares(middlewares, devServer);
    }

    return middlewares;
  },
};

// ============================================
// Optimize Webpack Stats for Faster Startup
// ============================================
config.stats = {
  all: false,
  errors: true,
  warnings: true,
  colors: true,
  // Minimal output for faster startup
  preset: "minimal",
  // Hide module trace for faster output
  moduleTrace: false,
  errorDetails: false,
};

// ============================================
// Create Dev Server Instance
// ============================================
const server = new WebpackDevServer(devServerOptions, compiler);

// ============================================
// Graceful Shutdown Handler
// ============================================
const shutdown = async (signal) => {
  console.log(`\n📡 Received ${signal}, shutting down gracefully...`);
  try {
    await server.stop();
    console.log("✅ Server stopped successfully");
    process.exit(0);
  } catch (error) {
    console.error("❌ Error during shutdown:", error.message);
    process.exit(1);
  }
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ============================================
// Start Server
// ============================================
const runServer = async () => {
  try {
    await server.start();

    const port = devServerOptions.port || config.devServer?.port || 8080;
    const host = devServerOptions.host || config.devServer?.host || "localhost";
    const modeLabel =
      process.env.ORGII_LIGHT_DEV === "true"
        ? "light, esbuild, no HMR/source maps"
        : isSlowMode
          ? "slow, ts-loader"
          : "fast, esbuild";

    console.log(`✨ ORG2 Dev Server: http://${host}:${port} (${modeLabel})`);
  } catch (error) {
    console.error("\n❌ Failed to start development server\n");
    console.error("Error:", error.message);

    if (error.code === "EADDRINUSE") {
      console.error(
        "\n💡 Port is already in use. Try killing existing process or change port.\n"
      );
    }

    process.exit(1);
  }
};

// ============================================
// Handle Uncaught Errors
// ============================================
process.on("uncaughtException", (error) => {
  console.error("\n❌ Uncaught Exception:", error.message, "\n");
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("\n❌ Unhandled Rejection:", reason, "\n");
  process.exit(1);
});

// ============================================
// Start
// ============================================
runServer();
