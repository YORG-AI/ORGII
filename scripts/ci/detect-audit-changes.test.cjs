const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const {
  isAuditInput,
  parseNullDelimitedPaths,
  requiresAudit,
} = require("./detect-audit-changes.cjs");

test("lockfile and ignore-list changes run the audit", () => {
  assert.equal(requiresAudit(["src-tauri/Cargo.lock"]), true);
  assert.equal(requiresAudit(["src-tauri/.cargo/audit.toml"]), true);
  assert.equal(
    requiresAudit(["src-tauri/src/lib.rs", "src-tauri/Cargo.lock"]),
    true
  );
});

test("source-only Rust changes cannot move the verdict", () => {
  // cargo audit never builds the workspace; these leave Cargo.lock untouched.
  assert.equal(
    requiresAudit([
      "src-tauri/src/lib.rs",
      "src-tauri/crates/agent_core/src/session.rs",
      "src/components/Button/index.tsx",
    ]),
    false
  );
});

test("a manifest edit that did not re-resolve is not an audit input", () => {
  // Cargo.toml alone cannot change the audited graph: the resolved versions
  // cargo audit reads live in Cargo.lock, and any real dependency change
  // rewrites it in the same commit.
  assert.equal(isAuditInput("src-tauri/Cargo.toml"), false);
  assert.equal(requiresAudit(["src-tauri/Cargo.toml"]), false);
});

test("lookalike paths outside the workspace do not trigger", () => {
  assert.equal(isAuditInput("Cargo.lock"), false);
  assert.equal(isAuditInput("docs/examples/Cargo.lock"), false);
  assert.equal(isAuditInput("src-tauri/Cargo.lock.bak"), false);
});

test("empty diffs fail closed", () => {
  assert.equal(requiresAudit([]), true);
});

test("NUL-delimited paths drive the CLI", () => {
  const input = Buffer.from("src-tauri/src/lib.rs\0src/a file.tsx\0");
  assert.deepEqual(parseNullDelimitedPaths(input), [
    "src-tauri/src/lib.rs",
    "src/a file.tsx",
  ]);

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "detect-audit-changes.cjs")],
    { input, encoding: "utf8" }
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "false\n");

  const locked = spawnSync(
    process.execPath,
    [path.join(__dirname, "detect-audit-changes.cjs")],
    { input: Buffer.from("src-tauri/Cargo.lock\0"), encoding: "utf8" }
  );
  assert.equal(locked.stdout, "true\n");
});
