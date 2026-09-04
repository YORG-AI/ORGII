const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const {
  isRustRelevantPath,
  parseNullDelimitedPaths,
  requiresRust,
} = require("./detect-rust-changes.cjs");

test("pure frontend source changes skip Rust", () => {
  assert.equal(
    requiresRust([
      "src/components/Button.tsx",
      "src/store/session.ts",
      "public/index.html",
    ]),
    false
  );
});

test("frontend configs, assets, and repository tests skip Rust", () => {
  assert.equal(
    requiresRust([
      "package.json",
      "pnpm-lock.yaml",
      "webpack.config.js",
      "config/commitlint.config.cjs",
      "config/postcss.config.js",
      "config/vitest.config.ts",
      "config/webpack.config.js",
      "assets/demo.png",
      "tests/e2e/specs/core/session.spec.mjs",
    ]),
    false
  );
});

test("documentation, agent tooling, and unknown paths skip Rust", () => {
  // The gate enumerates the Rust build's inputs; anything outside that set
  // skips the macOS runner, including paths no allowlist has heard of. The
  // old fail-closed-on-unknown rule burned ~30 min of clippy for changes
  // like a deleted frontend config or an .orgii skill edit.
  for (const filePath of [
    ".claude/CLAUDE.md",
    ".github/PR_RULES.md",
    ".orgii/skills/frontend-ui-audit/SKILL.md",
    "README.md",
    "docs/frontend-ui-audit-2026-08-31/Icons.md",
    "docs/development/build notes.md",
    "docs/examples/main.rs",
    "config/tailwind.config.js",
    "scripts/ci/select-lint-targets.cjs",
    "scripts/dev/webpack-server.js",
    "tools/org2-diagnostics/cli.mjs",
    "unknown.md",
    "README.md.backup",
  ]) {
    assert.equal(requiresRust([filePath]), false, filePath);
  }
});

test("Rust and mixed changes run Rust", () => {
  assert.equal(requiresRust(["src-tauri/src/lib.rs"]), true);
  assert.equal(requiresRust(["src-tauri/Cargo.toml"]), true);
  assert.equal(requiresRust(["src-tauri/tauri.conf.json"]), true);
  assert.equal(requiresRust(["src-tauri/README.md"]), true);
  assert.equal(
    requiresRust(["src/components/Button.tsx", "src-tauri/Cargo.lock"]),
    true
  );
  assert.equal(
    requiresRust([
      "docs/hugeicons-migration/icon-mapping.md",
      "src-tauri/src/lib.rs",
    ]),
    true
  );
});

test("build machinery the Rust job invokes stays in Rust scope", () => {
  assert.equal(requiresRust([".github/workflows/ci.yml"]), true);
  assert.equal(requiresRust([".github/workflows/warm-rust-cache.yml"]), true);
  assert.equal(requiresRust([".github/actions/setup/action.yml"]), true);
  assert.equal(requiresRust(["scripts/tauri/prepare-sidecars.cjs"]), true);
});

test("the gate cannot scope a diff that edits the gate itself", () => {
  assert.equal(requiresRust(["scripts/ci/detect-rust-changes.cjs"]), true);
  assert.equal(requiresRust(["scripts/ci/detect-rust-changes.test.cjs"]), true);
});

test("the PM protocol contract stays in Rust scope, including its Markdown", () => {
  for (const filePath of [
    "docs/orgtrack-pm-protocol/README.md",
    "docs/orgtrack-pm-protocol/decisions.md",
    "docs/orgtrack-pm-protocol/schemas/common.schema.json",
    "docs/orgtrack-pm-protocol/fixtures/routine-spec.json",
  ]) {
    assert.equal(requiresRust([filePath]), true, filePath);
  }
});

test("empty diffs fail closed", () => {
  assert.equal(requiresRust([]), true);
  assert.equal(isRustRelevantPath("src-tauri"), false);
  assert.equal(isRustRelevantPath("src-tauri/"), true);
});

test("NUL-delimited paths preserve whitespace and drive the CLI", () => {
  const input = Buffer.from(
    "src/a file.ts\0public/index.html\0docs/build notes.md\0"
  );
  assert.deepEqual(parseNullDelimitedPaths(input), [
    "src/a file.ts",
    "public/index.html",
    "docs/build notes.md",
  ]);

  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "detect-rust-changes.cjs")],
    {
      input,
      encoding: "utf8",
    }
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "false\n");
});
