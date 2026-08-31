#!/usr/bin/env node

// Decides how much of the tree `pnpm lint` has to cover for one pull request.
//
// ESLint is a per-file analysis here: every rule in package.json#eslintConfig reads a single
// module (unused imports, restricted imports/syntax, prettier formatting, hook
// deps). Nothing in the config is cross-file, so a pull request cannot make an
// untouched file newly non-compliant -- the cross-file class of breakage
// (deleted export, renamed symbol) is caught by `pnpm typecheck`, which stays
// whole-repo.
//
// The exception is anything that changes the *rules*: a config, plugin, or
// formatter bump re-judges all 6000+ files, so those diffs fall back to the
// full run. So does a diff we cannot read, matching detect-rust-changes.cjs.

const fs = require("node:fs");

const LINTABLE_EXTENSIONS = Object.freeze([".ts", ".tsx", ".js", ".jsx"]);

// package.json#eslintConfig ignores everything outside src/ (ignorePatterns "/*" + "!/src"),
// so passing a path from anywhere else would lint nothing and only slow the
// step down.
const LINTABLE_PREFIX = "src/";

// A change to any of these re-judges files the diff never touched, so the
// changed-file shortcut stops being sound and the full run has to happen.
const FULL_LINT_TRIGGERS = new Set([
  ".eslintrc.js",
  ".prettierrc",
  ".prettierignore",
  "config/tailwind.config.js",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
]);

function isLintable(filePath) {
  return (
    filePath.startsWith(LINTABLE_PREFIX) &&
    LINTABLE_EXTENSIONS.some((extension) => filePath.endsWith(extension))
  );
}

function requiresFullLint(filePaths) {
  // Fail closed when diff discovery yields nothing unexpectedly.
  return (
    filePaths.length === 0 ||
    filePaths.some((filePath) => FULL_LINT_TRIGGERS.has(filePath))
  );
}

// mode "all"   -> run `pnpm lint` over src/
// mode "files" -> lint exactly `files`
// mode "skip"  -> the diff touched no lintable file (docs, Rust, assets)
function selectLintTargets(filePaths) {
  if (requiresFullLint(filePaths)) {
    return { mode: "all", files: [] };
  }

  const files = filePaths.filter(isLintable);

  return files.length === 0
    ? { mode: "skip", files }
    : { mode: "files", files };
}

function parseNullDelimitedPaths(input) {
  return input.toString("utf8").split("\0").filter(Boolean);
}

if (require.main === module) {
  const outputIndex = process.argv.indexOf("--out");
  if (outputIndex === -1 || !process.argv[outputIndex + 1]) {
    process.stderr.write("usage: select-lint-targets.cjs --out <file>\n");
    process.exit(2);
  }

  const selection = selectLintTargets(
    parseNullDelimitedPaths(fs.readFileSync(0))
  );

  // NUL-delimited so the reader stays `xargs -0`: the same delimiter git
  // handed us, and the only one no path can contain.
  fs.writeFileSync(
    process.argv[outputIndex + 1],
    selection.files.map((filePath) => `${filePath}\0`).join("")
  );
  process.stdout.write(`lint_mode=${selection.mode}\n`);
  process.stderr.write(
    `Lint mode: ${selection.mode} (${selection.files.length} files)\n`
  );
}

module.exports = {
  isLintable,
  parseNullDelimitedPaths,
  requiresFullLint,
  selectLintTargets,
};
