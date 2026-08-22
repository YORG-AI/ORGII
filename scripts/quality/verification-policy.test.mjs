import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireTypecheckLock,
  buildVerificationFingerprint,
  exceedsAutodetectedFileLimit,
  isSuccessfulTypecheckCached,
  isTypecheckRelevant,
  lintableFiles,
  testRelatedFiles,
  vitestTestFiles,
  writeSuccessfulTypecheck,
} from "./verification-policy.mjs";

function fingerprint(overrides = {}) {
  return buildVerificationFingerprint({
    head: "head-1",
    files: [{ path: "src/example.ts", content: "export const value = 1;" }],
    nodeVersion: "v22",
    platform: "test-platform",
    typescriptVersion: "5.7.3",
    ...overrides,
  });
}

test("fingerprint changes with source, compiler, and deletion state", () => {
  const baseline = fingerprint();

  assert.notEqual(
    baseline,
    fingerprint({
      files: [{ path: "src/example.ts", content: "export const value = 2;" }],
    })
  );
  assert.notEqual(baseline, fingerprint({ typescriptVersion: "5.8.0" }));
  assert.notEqual(
    baseline,
    fingerprint({ files: [{ path: "src/example.ts", content: null }] })
  );
});

test("test and typecheck scopes exclude unrelated repository tooling", () => {
  assert.equal(exceedsAutodetectedFileLimit(Array.from({ length: 80 })), false);
  assert.equal(exceedsAutodetectedFileLimit(Array.from({ length: 81 })), true);
  assert.deepEqual(
    lintableFiles([
      "src/example.ts",
      "packages/ui/example.tsx",
      "scripts/quality/example.mjs",
    ]),
    ["src/example.ts"]
  );
  assert.deepEqual(
    vitestTestFiles([
      "src/example.ts",
      "src/example.test.ts",
      "src/example.spec.tsx",
      "scripts/example.test.mjs",
    ]),
    ["src/example.test.ts"]
  );
  assert.deepEqual(
    testRelatedFiles([
      "src/example.ts",
      "packages/ui/example.tsx",
      "scripts/quality/example.mjs",
      "tests/e2e/example.spec.mjs",
    ]),
    ["src/example.ts"]
  );
  assert.equal(isTypecheckRelevant("src/example.ts"), true);
  assert.equal(isTypecheckRelevant("packages/ui/example.tsx"), true);
  assert.equal(isTypecheckRelevant("package.json"), true);
  assert.equal(isTypecheckRelevant("scripts/quality/example.mjs"), false);
  assert.equal(
    isTypecheckRelevant("tmp/copied-worktree/src/example.ts"),
    false
  );
});

test("successful cache contains only the latest fingerprint", () => {
  const directory = mkdtempSync(join(tmpdir(), "orgii-verification-"));
  const cachePath = join(directory, "typecheck.json");

  try {
    const first = fingerprint();
    const second = fingerprint({ head: "head-2" });

    writeSuccessfulTypecheck(first, cachePath);
    assert.equal(isSuccessfulTypecheckCached(first, cachePath), true);
    assert.equal(isSuccessfulTypecheckCached(second, cachePath), false);

    writeSuccessfulTypecheck(second, cachePath);
    assert.equal(isSuccessfulTypecheckCached(first, cachePath), false);
    assert.equal(isSuccessfulTypecheckCached(second, cachePath), true);
    assert.equal(JSON.parse(readFileSync(cachePath, "utf8")).schemaVersion, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("typecheck lock blocks a duplicate process and recovers a stale lock", () => {
  const directory = mkdtempSync(join(tmpdir(), "orgii-verification-lock-"));
  const lockPath = join(directory, "typecheck.lock");

  try {
    const release = acquireTypecheckLock(lockPath);
    assert.equal(typeof release, "function");
    assert.equal(acquireTypecheckLock(lockPath), null);
    release();

    writeFileSync(lockPath, JSON.stringify({ pid: 999_999_999 }), "utf8");
    const releaseRecovered = acquireTypecheckLock(lockPath);
    assert.equal(typeof releaseRecovered, "function");
    releaseRecovered();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
