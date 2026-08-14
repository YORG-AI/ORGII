import { spawnSync } from "node:child_process";
import process from "node:process";

import {
  exceedsAutodetectedFileLimit,
  existingFiles,
  lintableFiles,
  listWorkspaceChanges,
  normalizeRequestedFiles,
  repoRoot,
  testRelatedFiles,
  vitestTestFiles,
} from "./verification-policy.mjs";

const rawArguments = process.argv.slice(2).filter((path) => path !== "--");
const skipTests = rawArguments.includes("--no-tests");
const requestedFiles = rawArguments.filter((path) => path !== "--no-tests");
const autodetected = requestedFiles.length === 0;
const scopedFiles = autodetected
  ? listWorkspaceChanges()
  : normalizeRequestedFiles(requestedFiles);

if (autodetected && exceedsAutodetectedFileLimit(scopedFiles)) {
  process.stderr.write(
    `Refusing to scan ${scopedFiles.length} workspace changes automatically. ` +
      `Pass this task's exact files: pnpm verify:quick -- <file ...>\n`
  );
  process.exit(2);
}

const files = existingFiles(scopedFiles);
const lintFiles = lintableFiles(files);
const frontendFiles = testRelatedFiles(files);
const testFiles = vitestTestFiles(frontendFiles);
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function run(args) {
  const result = spawnSync(pnpm, args, {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

process.stdout.write(
  `Quick verification scope: ${files.length} existing file(s)` +
    `${autodetected ? " (auto-detected)" : " (explicit task scope)"}\n`
);

if (lintFiles.length > 0) {
  process.stdout.write(`Linting ${lintFiles.length} changed file(s)...\n`);
  run(["exec", "eslint", ...lintFiles]);
} else {
  process.stdout.write(
    "Lint skipped: no changed files in the configured src/ scope.\n"
  );
}

if (testFiles.length > 0) {
  process.stdout.write(
    `Running ${testFiles.length} explicitly scoped Vitest file(s)...\n`
  );
  run(["exec", "vitest", "run", ...testFiles]);
} else if (frontendFiles.length > 0 && !skipTests) {
  process.stderr.write(
    "No focused Vitest file was supplied for changed src/ code. Add the relevant *.test.ts file, or pass --no-tests with a documented reason.\n"
  );
  process.exit(2);
} else {
  process.stdout.write(
    skipTests
      ? "Focused tests explicitly skipped with --no-tests.\n"
      : "Focused tests skipped: no changed files in the configured src/ scope.\n"
  );
}
