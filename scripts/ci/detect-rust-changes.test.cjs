const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");

const {
  isFrontendOnlyPath,
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
      "config/tailwind.config.js",
      "config/vitest.config.ts",
      "config/webpack.config.js",
      "assets/demo.png",
      "tests/e2e/specs/core/session.spec.mjs",
    ]),
    false
  );
});

test("frontend changes with supporting Markdown docs skip Rust", () => {
  assert.equal(
    requiresRust([
      "src/icons.ts",
      "src/config/segmentRegistry.ts",
      "docs/hugeicons-migration/icon-mapping.md",
    ]),
    false
  );
});

test("ordinary Markdown documentation alone skips Rust", () => {
  for (const filePath of [
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
    "docs/frontend-ui-audit-2026-08-31/Icons.md",
    "docs/development/build notes.md",
  ]) {
    assert.equal(requiresRust([filePath]), false, filePath);
  }
});

test("Rust and mixed changes run Rust", () => {
  assert.equal(requiresRust(["src-tauri/src/lib.rs"]), true);
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

test("workflow, script, and protocol changes run Rust conservatively", () => {
  assert.equal(requiresRust([".github/workflows/ci.yml"]), true);
  assert.equal(requiresRust([".github/actions/build/README.md"]), true);
  assert.equal(requiresRust(["scripts/tauri/prepare-sidecars.cjs"]), true);
  assert.equal(requiresRust(["docs/orgtrack-pm-protocol/README.md"]), true);
});

test("Rust contracts and non-Markdown documentation inputs stay in Rust scope", () => {
  for (const filePath of [
    "docs/orgtrack-pm-protocol/decisions.md",
    "docs/orgtrack-pm-protocol/schemas/common.schema.json",
    "docs/orgtrack-pm-protocol/fixtures/routine-spec.json",
    "docs/examples/Cargo.lock",
    "docs/examples/main.rs",
    "docs/fixtures/example.json",
    "src-tauri/README.md",
  ]) {
    assert.equal(requiresRust([filePath]), true, filePath);
  }
});

test("empty or unknown diffs fail closed", () => {
  assert.equal(requiresRust([]), true);
  assert.equal(requiresRust(["unknown.md"]), true);
  assert.equal(requiresRust(["README.md.backup"]), true);
  assert.equal(requiresRust([".github/SECURITY.md.backup"]), true);
  assert.equal(requiresRust(["docs/notes.md.backup"]), true);
  assert.equal(isFrontendOnlyPath("package.json.backup"), false);
  assert.equal(requiresRust(["config/webpack.config.js.backup"]), true);
  assert.equal(requiresRust(["config/rust-build.json"]), true);
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
