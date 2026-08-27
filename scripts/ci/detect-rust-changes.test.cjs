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
      "assets/demo.png",
      "tests/e2e/specs/core/session.spec.mjs",
    ]),
    false
  );
});

test("Rust and mixed changes run Rust", () => {
  assert.equal(requiresRust(["src-tauri/src/lib.rs"]), true);
  assert.equal(
    requiresRust(["src/components/Button.tsx", "src-tauri/Cargo.lock"]),
    true
  );
});

test("workflow, script, and protocol changes run Rust conservatively", () => {
  assert.equal(requiresRust([".github/workflows/ci.yml"]), true);
  assert.equal(requiresRust(["scripts/tauri/prepare-sidecars.cjs"]), true);
  assert.equal(requiresRust(["docs/orgtrack-pm-protocol/README.md"]), true);
});

test("empty or unknown diffs fail closed", () => {
  assert.equal(requiresRust([]), true);
  assert.equal(requiresRust(["README.md"]), true);
  assert.equal(isFrontendOnlyPath("package.json.backup"), false);
});

test("NUL-delimited paths preserve whitespace and drive the CLI", () => {
  const input = Buffer.from("src/a file.ts\0public/index.html\0");
  assert.deepEqual(parseNullDelimitedPaths(input), [
    "src/a file.ts",
    "public/index.html",
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
