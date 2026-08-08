#!/usr/bin/env node
/**
 * Background stats collection - runs detached from pre-commit hook.
 * Collects project-wide eslint/circular stats without blocking commits.
 */
import { spawn } from "child_process";
import { existsSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const STATS_FILE = join(ROOT, ".git", "COMMIT_STATS.json");

function run(cmd, args) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });
    let stdout = "";
    proc.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    // Drain stderr even though we discard it. The circular gate prints one
    // line per unresolved specifier — in --json mode too — which on a tree
    // whose tsconfig `paths` stopped resolving is ~88KB, past the OS pipe
    // buffer. An undrained pipe blocks the child mid-write while we await
    // `close`, and this process is spawned detached with stdio "ignore", so
    // the deadlock is invisible: COMMIT_STATS.json is never rewritten and
    // prepare-commit-msg keeps stamping the PREVIOUS run's numbers onto
    // every later commit. `commit-stats.mjs` drains for the same reason.
    proc.stderr?.on("data", () => {});
    proc.on("close", () => resolve(stdout));
    proc.on("error", () => resolve(""));
  });
}

function countEslint(jsonStr) {
  try {
    const results = JSON.parse(jsonStr);
    if (!Array.isArray(results)) return 0;
    return results.reduce((sum, file) => {
      const messages = file.messages ?? [];
      const isIgnoredFileOnly =
        messages.length > 0 &&
        messages.every((m) =>
          m.message?.includes("ignored because of a matching ignore pattern")
        );
      if (isIgnoredFileOnly) return sum;
      return sum + (file.errorCount ?? 0) + (file.warningCount ?? 0);
    }, 0);
  } catch {
    return 0;
  }
}

function countCircular(jsonStr) {
  try {
    const cycles = JSON.parse(jsonStr);
    return Array.isArray(cycles) ? cycles.length : 0;
  } catch {
    return 0;
  }
}

async function main() {
  const [madgeOut, eslintOut] = await Promise.all([
    run("node", ["scripts/quality/check-circular-dependencies.mjs", "--json"]),
    run("npx", ["eslint", "src/", "--format", "json"]),
  ]);

  const eslintCount = countEslint(eslintOut);
  const circularCount = countCircular(madgeOut);

  const gitDir = join(ROOT, ".git");
  if (existsSync(gitDir)) {
    writeFileSync(
      STATS_FILE,
      JSON.stringify({ eslint: eslintCount, circular: circularCount }) + "\n",
      "utf8"
    );
  }
}

main().catch(() => process.exit(0));
