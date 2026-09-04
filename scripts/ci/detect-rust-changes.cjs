#!/usr/bin/env node

const fs = require("node:fs");

// The Rust jobs (clippy + workspace tests) read a bounded set of inputs, so
// the gate enumerates those inputs and fires only when the diff touches one.
// Everything else — frontend code, configs, docs, agent skills, unrelated
// tooling — skips the macOS runner. This replaces the old inverted rule
// ("skip only when every path is on a frontend/docs allowlist"), which ran
// ~30 min of clippy for any path the allowlist had never heard of.
//
// If the Rust build grows a new out-of-tree input (a codegen script, a shared
// fixture directory), it must be added here in the same change.
const RUST_RELEVANT_PREFIXES = Object.freeze([
  // The entire workspace: crates, Cargo.toml/Cargo.lock, .cargo/, tauri
  // configs, capabilities, icons bundled into the binary.
  "src-tauri/",
  // Schemas and fixtures read by Rust protocol-conformance tests; the whole
  // contract stays in Rust scope, including its Markdown.
  "docs/orgtrack-pm-protocol/",
  // The Rust CI job shells out to these before building (sidecar prep, build
  // helpers), so their behavior is part of the build.
  "scripts/tauri/",
  // Workflow definitions and composite actions decide how (and whether) the
  // Rust jobs run.
  ".github/workflows/",
  ".github/actions/",
]);

const RUST_RELEVANT_FILES = new Set([
  // The gate itself and its test: a diff that edits the detector must not be
  // trusted to scope itself.
  "scripts/ci/detect-rust-changes.cjs",
  "scripts/ci/detect-rust-changes.test.cjs",
]);

function isRustRelevantPath(filePath) {
  return (
    RUST_RELEVANT_FILES.has(filePath) ||
    RUST_RELEVANT_PREFIXES.some((prefix) => filePath.startsWith(prefix))
  );
}

function requiresRust(filePaths) {
  // Fail closed when diff discovery yields nothing unexpectedly.
  return filePaths.length === 0 || filePaths.some(isRustRelevantPath);
}

function parseNullDelimitedPaths(input) {
  return input.toString("utf8").split("\0").filter(Boolean);
}

if (require.main === module) {
  const filePaths = parseNullDelimitedPaths(fs.readFileSync(0));
  process.stdout.write(`${requiresRust(filePaths)}\n`);
}

module.exports = {
  isRustRelevantPath,
  parseNullDelimitedPaths,
  requiresRust,
};
