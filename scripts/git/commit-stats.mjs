#!/usr/bin/env node
/**
 * Kicks off project-wide ESLint/circular-dependency stats for the
 * prepare-commit-msg trailer.
 *
 * This script does NOT gate the commit and does NOT lint. The staged-file
 * ESLint gate is lint-staged, which runs earlier in .husky/pre-commit and
 * aborts on any remaining error; this file used to re-lint the same staged
 * files a third time in a fresh `npx eslint` process, which cost seconds of
 * config/plugin-graph resolution and bought nothing.
 *
 * The project-wide counts are collected by commit-stats-background.mjs, which
 * is spawned detached so the commit returns immediately.
 */
import { execSync, spawn } from "child_process";
import { existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

function getStagedSourceFiles() {
  try {
    const raw = execSync(
      "git diff --cached --name-only --diff-filter=ACMR -- '*.ts' '*.tsx' '*.js' '*.jsx'",
      { cwd: ROOT, encoding: "utf8" },
    );
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function main() {
  const stagedFiles = getStagedSourceFiles();
  console.log(
    `📊 Staged files linted by lint-staged (${stagedFiles.length} files)`,
  );

  // ─────────────────────────────────────────────────────────────────────────
  // NON-BLOCKING: Spawn detached process for project-wide stats
  // These don't gate the commit, just write stats for prepare-commit-msg.
  // The child self-limits to one run at a time (see its lock), so committing
  // repeatedly can no longer stack concurrent full-repo ESLint runs.
  // ─────────────────────────────────────────────────────────────────────────
  const bgScript = join(__dirname, "commit-stats-background.mjs");
  if (existsSync(bgScript)) {
    const child = spawn("node", [bgScript], {
      cwd: ROOT,
      detached: true,
      stdio: "ignore",
    });
    child.unref(); // Don't wait for this process
  }

  console.log("📊 Project stats: collecting in background...");
}

main().catch(() => process.exit(0));
