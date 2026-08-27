#!/usr/bin/env node

const fs = require("node:fs");

// Keep this list deliberately narrow. Rust may be skipped only when every
// changed file is known to be consumed exclusively by frontend tooling.
const FRONTEND_ONLY_PREFIXES = Object.freeze([
  "assets/",
  "build/",
  "public/",
  "src/",
  "tests/",
]);

const FRONTEND_ONLY_ROOT_FILES = new Set([
  "commitlint.config.cjs",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "postcss.config.js",
  "tailwind.config.js",
  "tsconfig.json",
  "vitest.config.ts",
  "webpack.config.js",
]);

function isFrontendOnlyPath(filePath) {
  return (
    FRONTEND_ONLY_ROOT_FILES.has(filePath) ||
    FRONTEND_ONLY_PREFIXES.some((prefix) => filePath.startsWith(prefix))
  );
}

function requiresRust(filePaths) {
  // Fail closed when diff discovery yields nothing unexpectedly.
  return (
    filePaths.length === 0 ||
    filePaths.some((filePath) => !isFrontendOnlyPath(filePath))
  );
}

function parseNullDelimitedPaths(input) {
  return input.toString("utf8").split("\0").filter(Boolean);
}

if (require.main === module) {
  const filePaths = parseNullDelimitedPaths(fs.readFileSync(0));
  process.stdout.write(`${requiresRust(filePaths)}\n`);
}

module.exports = {
  isFrontendOnlyPath,
  parseNullDelimitedPaths,
  requiresRust,
};
