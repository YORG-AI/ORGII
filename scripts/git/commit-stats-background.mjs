#!/usr/bin/env node
/**
 * Background stats collection - runs detached from pre-commit hook.
 * Collects project-wide eslint/circular stats without blocking commits.
 */
import { spawn } from "child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const STATS_FILE = join(ROOT, ".git", "COMMIT_STATS.json");
const LOCK_FILE = join(ROOT, ".git", "COMMIT_STATS.lock");

function isAlive(pid) {
  try {
    // Signal 0 performs the permission/existence check without delivering.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the pid exists but belongs to another user — still alive.
    return err?.code === "EPERM";
  }
}

/**
 * Single-flight guard.
 *
 * This process is spawned detached and unref'd, and it runs a full-repo
 * `eslint src/` plus madge — hundreds of MB and minutes of CPU. Without a
 * lock, every commit started another one, so a few commits in quick
 * succession (or several agent sessions sharing one checkout) stacked
 * concurrent full-repo lints that outlived the commits that spawned them.
 *
 * Skipping is the right behavior rather than queueing: the run already in
 * flight is reading a tree at least as new as ours, and prepare-commit-msg
 * already tolerates trailing-by-one-commit numbers.
 */
function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // "wx" fails if the file exists, so creation is atomic between racing
      // commits rather than a check-then-write window.
      const fd = openSync(LOCK_FILE, "wx");
      try {
        writeSync(fd, String(process.pid));
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (err) {
      // ENOENT/ENOTDIR: no .git directory to lock in (e.g. a linked worktree,
      // where .git is a file). Nothing to collect into either — just bail.
      if (err?.code !== "EEXIST") return false;

      let holder = NaN;
      try {
        holder = Number.parseInt(readFileSync(LOCK_FILE, "utf8").trim(), 10);
      } catch {
        // Unreadable lock is treated as stale below.
      }
      if (Number.isInteger(holder) && isAlive(holder)) return false;

      // Stale lock from a killed run — clear it and retry once.
      try {
        unlinkSync(LOCK_FILE);
      } catch {
        return false;
      }
    }
  }
  return false;
}

function releaseLock() {
  try {
    unlinkSync(LOCK_FILE);
  } catch {
    // Already gone.
  }
}

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
  if (!acquireLock()) return;

  try {
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
  } finally {
    releaseLock();
  }
}

// Release on abnormal termination too, so a killed run does not leave a lock
// that blocks the next commit until the stale-pid check clears it.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    releaseLock();
    process.exit(0);
  });
}

main().catch(() => {
  releaseLock();
  process.exit(0);
});
