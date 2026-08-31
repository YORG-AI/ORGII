#!/usr/bin/env node

const fs = require("node:fs");

// Keep the skip rules deliberately narrow. Rust may be skipped only when
// every changed file is frontend-only or documentation with no Rust inputs.
const FRONTEND_ONLY_PREFIXES = Object.freeze([
  "assets/",
  "build/",
  "public/",
  "src/",
  "tests/",
]);

const FRONTEND_ONLY_FILES = new Set([
  "config/commitlint.config.cjs",
  "config/postcss.config.js",
  "config/tailwind.config.js",
  "config/vitest.config.ts",
  "config/webpack.config.js",
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

const DOCUMENTATION_FILES = new Set([
  ".claude/CLAUDE.md",
  ".github/CODE_OF_CONDUCT.md",
  ".github/CONTRIBUTING.md",
  ".github/PR_RULES.md",
  ".github/SECURITY.md",
  "AGENTS.md",
  "CLAUDE.md",
  "CODE_OF_CONDUCT.md",
  "CONTRIBUTING.md",
  "PR_RULES.md",
  "README.md",
  "SECURITY.md",
]);

function isFrontendOnlyPath(filePath) {
  return (
    FRONTEND_ONLY_FILES.has(filePath) ||
    FRONTEND_ONLY_PREFIXES.some((prefix) => filePath.startsWith(prefix))
  );
}

function isDocumentationOnlyPath(filePath) {
  // The PM protocol directory contains schemas and fixtures read by Rust
  // conformance tests. Keep the entire contract in Rust scope, including
  // its Markdown docs; do not exempt arbitrary files under docs/.
  return (
    DOCUMENTATION_FILES.has(filePath) ||
    (filePath.startsWith("docs/") &&
      filePath.endsWith(".md") &&
      !filePath.startsWith("docs/orgtrack-pm-protocol/"))
  );
}

function requiresRust(filePaths) {
  // Fail closed when diff discovery yields nothing unexpectedly.
  return (
    filePaths.length === 0 ||
    filePaths.some(
      (filePath) =>
        !isFrontendOnlyPath(filePath) && !isDocumentationOnlyPath(filePath)
    )
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
