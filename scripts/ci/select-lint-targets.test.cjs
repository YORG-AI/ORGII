const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  isLintable,
  parseNullDelimitedPaths,
  requiresFullLint,
  selectLintTargets,
} = require("./select-lint-targets.cjs");

test("source changes lint exactly the files they touch", () => {
  assert.deepEqual(
    selectLintTargets([
      "src/components/Button/index.tsx",
      "src/store/session.ts",
      "src/scripts/legacy.jsx",
    ]),
    {
      mode: "files",
      files: [
        "src/components/Button/index.tsx",
        "src/store/session.ts",
        "src/scripts/legacy.jsx",
      ],
    }
  );
});

test("non-lintable paths are dropped, not linted", () => {
  // package.json#eslintConfig confines linting to src/ and skips CSS/SCSS, so handing these
  // to ESLint would cost a process start and report nothing.
  assert.equal(isLintable("src/styles/_utilities.scss"), false);
  assert.equal(isLintable("src/assets/logo.svg"), false);
  assert.equal(isLintable("scripts/ci/pr-policy.cjs"), false);
  assert.equal(isLintable("tests/e2e/specs/core/session.spec.mjs"), false);
  assert.equal(isLintable("src/components/Button/index.tsx"), true);

  assert.deepEqual(
    selectLintTargets(["src/styles/_utilities.scss", "docs/audit/GLOBAL.md"]),
    { mode: "skip", files: [] }
  );
});

test("mixed diffs lint only the lintable half", () => {
  assert.deepEqual(
    selectLintTargets([
      "docs/frontend-ui-audit-2026-08-28/GLOBAL.md",
      "src-tauri/src/lib.rs",
      "src/modules/shared/layouts/blocks/DetailTabStrip.tsx",
    ]),
    {
      mode: "files",
      files: ["src/modules/shared/layouts/blocks/DetailTabStrip.tsx"],
    }
  );
});

test("rule-changing diffs fall back to the full run", () => {
  // These re-judge files the diff never touched, so per-file selection is no
  // longer sound.
  for (const trigger of [
    ".eslintrc.js",
    ".prettierrc",
    ".prettierignore",
    "src/tailwind.css",
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
  ]) {
    assert.equal(requiresFullLint([trigger, "src/a.ts"]), true, trigger);
    assert.deepEqual(selectLintTargets([trigger, "src/a.ts"]), {
      mode: "all",
      files: [],
    });
  }
});

test("empty diffs fail closed", () => {
  assert.equal(requiresFullLint([]), true);
  assert.deepEqual(selectLintTargets([]), { mode: "all", files: [] });
});

test("NUL-delimited paths preserve whitespace and drive the CLI", () => {
  const input = Buffer.from("src/a file.tsx\0docs/notes.md\0");
  assert.deepEqual(parseNullDelimitedPaths(input), [
    "src/a file.tsx",
    "docs/notes.md",
  ]);

  const outFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "lint-targets-")),
    "targets.txt"
  );
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "select-lint-targets.cjs"), "--out", outFile],
    { input, encoding: "utf8" }
  );

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "lint_mode=files\n");
  assert.equal(fs.readFileSync(outFile, "utf8"), "src/a file.tsx\0");
});

test("the CLI refuses to run without an output path", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(__dirname, "select-lint-targets.cjs")],
    { input: Buffer.from("src/a.ts\0"), encoding: "utf8" }
  );

  assert.equal(result.status, 2);
});
