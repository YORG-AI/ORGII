#!/usr/bin/env node

// Decides whether a diff can change what `cargo audit` reports.
//
// cargo audit reads exactly two things from this repository: the resolved
// dependency graph in src-tauri/Cargo.lock, and the ignore list in
// src-tauri/.cargo/audit.toml. It never builds the workspace, so a diff that
// only edits .rs sources cannot move its verdict -- yet the job was gated on
// detect-rust-changes.cjs, which fires for any Rust-relevant path, and each
// cold run spends ~3 min compiling cargo-audit before a 4 s scan.
//
// Its third input, the RustSec advisory database, moves on its own schedule
// with no diff at all. That is why nightly-full-checks.yml runs cargo audit
// unconditionally: a new advisory against an unchanged lockfile has to be
// caught by the clock, never by a pull request.

const fs = require("node:fs");

const AUDIT_INPUTS = new Set([
  "src-tauri/Cargo.lock",
  "src-tauri/.cargo/audit.toml",
]);

function isAuditInput(filePath) {
  return AUDIT_INPUTS.has(filePath);
}

function requiresAudit(filePaths) {
  // Fail closed when diff discovery yields nothing unexpectedly, matching
  // detect-rust-changes.cjs.
  return filePaths.length === 0 || filePaths.some(isAuditInput);
}

function parseNullDelimitedPaths(input) {
  return input.toString("utf8").split("\0").filter(Boolean);
}

if (require.main === module) {
  const filePaths = parseNullDelimitedPaths(fs.readFileSync(0));
  process.stdout.write(`${requiresAudit(filePaths)}\n`);
}

module.exports = {
  AUDIT_INPUTS,
  isAuditInput,
  parseNullDelimitedPaths,
  requiresAudit,
};
