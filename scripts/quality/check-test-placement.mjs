#!/usr/bin/env node

/**
 * Fails when a directory mixes the two test-placement conventions.
 *
 * `.github/CONTRIBUTING.md` ("Where tests live") allows either style — a test colocated
 * beside its source, or one inside a `__tests__/` subdirectory — but requires a
 * directory to pick one. A directory holding both leaves no way to tell where a
 * new test belongs, which is how the repo drifted to 53 mixed directories before
 * they were normalized.
 *
 * Documentation alone did not hold: two directories re-mixed within a day of the
 * cleanup landing, which is why this check exists.
 */

import { readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..", "..");
const SRC = join(ROOT, "src");

/** Every `*.test.ts` under `src/`, as paths relative to ROOT. */
function collectTests(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      collectTests(full, out);
    } else if (entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

// Group by the directory that *owns* the tests: for a `__tests__/x.test.ts`
// that is the parent of `__tests__`, so both styles land in the same bucket.
const owners = new Map();
for (const file of collectTests(SRC)) {
  const inTestsDir = dirname(file).endsWith(`${"__tests__"}`);
  const owner = inTestsDir ? dirname(dirname(file)) : dirname(file);
  const bucket = owners.get(owner) ?? { colocated: [], testsDir: [] };
  (inTestsDir ? bucket.testsDir : bucket.colocated).push(file);
  owners.set(owner, bucket);
}

const mixed = [...owners.entries()].filter(
  ([, v]) => v.colocated.length > 0 && v.testsDir.length > 0
);

if (mixed.length === 0) {
  console.log(
    `Test placement is consistent across ${owners.size} directories.`
  );
  process.exit(0);
}

console.error(
  `${mixed.length} director${mixed.length === 1 ? "y mixes" : "ies mix"} both test-placement conventions.`
);
console.error(
  `Each directory must pick one — see .github/CONTRIBUTING.md "Where tests live".\n`
);

for (const [owner, { colocated, testsDir }] of mixed) {
  const rel = (p) => p.slice(ROOT.length + 1);
  // Name the minority side: moving it is the smaller, more likely fix. On a tie,
  // keep `__tests__/` — the newcomer should join the incumbent, and a tie means
  // the colocated file is usually the one that just arrived.
  const moveTestsDir = testsDir.length < colocated.length;
  console.error(`  ${rel(owner)}`);
  console.error(
    `    ${colocated.length} colocated, ${testsDir.length} in __tests__/ — move the ${moveTestsDir ? "__tests__/" : "colocated"} file${(moveTestsDir ? testsDir : colocated).length === 1 ? "" : "s"}:`
  );
  for (const f of moveTestsDir ? testsDir : colocated) {
    console.error(`      ${rel(f)}`);
  }
}

process.exitCode = 1;
