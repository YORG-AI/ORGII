#!/usr/bin/env node

/**
 * Bound the developer build caches so they cannot grow without limit.
 *
 * Why this exists
 * ---------------
 * Three separate build caches grow on every branch, worktree and identity
 * build, and nothing in Cargo or webpack ever reclaims them:
 *
 *   1. `~/.cargo/shared-target`   - shared by every Rust project on the
 *      machine (`[build] target-dir` in `~/.cargo/config.toml`). Every
 *      distinct crate hash lands here forever; a busy week of worktrees
 *      adds tens of gigabytes.
 *   2. `src-tauri/target[-instance2]` - `scripts/tauri/build-fast-dual.cjs`
 *      sets `CARGO_TARGET_DIR` to these explicitly, so they are NOT covered
 *      by the shared-target setting above and grow as a second copy.
 *   3. `node_modules/.cache/webpack` - one pack namespace per build mode
 *      (`development` / `production`), each multiple GB.
 *
 * Strategy: sweep, do not wipe
 * ----------------------------
 * The previous version of this script `rm -rf`'d the whole Cargo target dir
 * once it crossed a limit. That is why it was never wired up anywhere -
 * paying a full cold rebuild of every Rust project on the machine is far too
 * expensive to trigger automatically.
 *
 * Instead we drive `cargo-sweep --maxsize`, which evicts *oldest artifacts
 * first* until the directory fits the cap. Run at dev start-up that is
 * exactly the right eviction order: stale branch/worktree artifacts go, and
 * the artifacts for the project you are about to build survive. A full wipe
 * is only used as a fallback when `cargo-sweep` is unavailable AND the
 * directory is over the hard ceiling.
 *
 * Usage
 * -----
 *   node scripts/dev/clean-cache-if-large.js              # enforce limits
 *   node scripts/dev/clean-cache-if-large.js --report     # show sizes only
 *   node scripts/dev/clean-cache-if-large.js --stale      # only orphaned
 *                                                         #   `-working` dirs
 *   node scripts/dev/clean-cache-if-large.js --worktrees  # reap merged
 *                                                         #   worktrees
 *   node scripts/dev/clean-cache-if-large.js --full       # also prune the
 *                                                         #   global registry,
 *                                                         #   pnpm/npm stores
 *                                                         #   and worktrees
 *   node scripts/dev/clean-cache-if-large.js --node-cache # drop webpack cache
 *   node scripts/dev/clean-cache-if-large.js --force      # ignore busy guard
 *
 * This is the single entry point for build-cache cleanup. It replaced
 * `scripts/maintenance/cargo-cleanup.sh`, which carried a second copy of the
 * target-dir resolution and the busy-process guard and had already drifted
 * (it could not see an app binary running out of the target dir).
 *
 * Tunables (all optional, bytes unless the name says GB):
 *   ORGII_MAX_NODE_CACHE_BYTES     default 3GB
 *   ORGII_MAX_CARGO_TARGET_BYTES   default 20GB  (trigger)
 *   ORGII_CARGO_TARGET_KEEP_GB     default 10    (sweep down to this)
 *   ORGII_MAX_DUAL_TARGET_BYTES    default 10GB  (per dual-build target dir)
 *   ORGII_ORPHAN_TARGET_MIN_AGE_DAYS default 3
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const GB = 1024 * 1024 * 1024;

const repoRoot = path.resolve(__dirname, "..", "..");
const cargoHome = process.env.CARGO_HOME || path.join(os.homedir(), ".cargo");
const cargoConfigPath = path.join(cargoHome, "config.toml");
const defaultCargoTargetPath = path.join(cargoHome, "shared-target");

// rust-analyzer is usually pointed at its own target dir so IDE checks do not
// fight the CLI for the build lock (`rust-analyzer.cargo.targetDir`).
const rustAnalyzerTargetPath = path.join(cargoHome, "shared-target-ra");

// The crate `cargo-sweep` is pointed at to resolve a target dir via metadata.
const cargoProjectDir = path.join(repoRoot, "src-tauri");

function envBytes(name, fallbackBytes) {
  const raw = process.env[name];
  if (!raw) return fallbackBytes;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackBytes;
}

function envInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const limits = {
  nodeCacheBytes: envBytes("ORGII_MAX_NODE_CACHE_BYTES", 3 * GB),
  cargoTargetBytes: envBytes("ORGII_MAX_CARGO_TARGET_BYTES", 20 * GB),
  cargoKeepGb: envInt("ORGII_CARGO_TARGET_KEEP_GB", 10),
  dualTargetBytes: envBytes("ORGII_MAX_DUAL_TARGET_BYTES", 10 * GB),
  orphanMinAgeDays: envInt("ORGII_ORPHAN_TARGET_MIN_AGE_DAYS", 3),
};

/* ------------------------------------------------------------------ *
 * Pure helpers (unit-tested in clean-cache-if-large.test.cjs)
 * ------------------------------------------------------------------ */

/**
 * Extract `[build] target-dir` from a `~/.cargo/config.toml` body.
 * Returns null when unset so the caller can apply its own default.
 */
function parseCargoTargetDir(configText, homedir) {
  const match = configText?.match(/^\s*target-dir\s*=\s*"([^"]+)"/m);
  if (!match?.[1]) return null;
  return match[1].replace(/^~(?=\/|$)/, homedir);
}

/**
 * A cleanup of `targetPath` is unsafe while a compiler is running, or while
 * a binary that *lives inside* that directory is running.
 *
 * The second case is the bug in the original script: `npm run tauri:dev`
 * launches the app straight out of `shared-target/debug/`, and neither
 * `pgrep -x cargo` nor `pgrep -x rustc` matches that process. Sweeping then
 * deletes artifacts out from under a live app.
 *
 * `psOutput` is `ps -Ao pid=,comm=` style text; comm is a full exec path.
 */
function findBlockingProcesses(psOutput, targetPath) {
  const blockers = [];
  const normalizedTarget = targetPath.endsWith(path.sep)
    ? targetPath
    : `${targetPath}${path.sep}`;

  for (const line of (psOutput || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separator = trimmed.indexOf(" ");
    if (separator === -1) continue;
    const pid = trimmed.slice(0, separator);
    const command = trimmed.slice(separator + 1).trim();
    const base = path.basename(command);

    if (base === "cargo" || base === "rustc") {
      blockers.push({ pid, command, reason: "compiler running" });
      continue;
    }
    if (command.startsWith(normalizedTarget)) {
      blockers.push({ pid, command, reason: "binary running from target dir" });
    }
  }
  return blockers;
}

/** Decide whether a directory is over its limit. */
function isOverLimit(sizeBytes, limitBytes) {
  return sizeBytes > limitBytes;
}

function formatBytes(bytes) {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)}GB`;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)}MB`;
  return `${Math.round(bytes / 1024)}KB`;
}

/* ------------------------------------------------------------------ *
 * Filesystem / process side effects
 * ------------------------------------------------------------------ */

function directorySizeBytes(directoryPath) {
  if (!fs.existsSync(directoryPath)) return 0;
  try {
    const output = execFileSync("du", ["-sk", directoryPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const kilobytes = Number.parseInt(output.trim().split(/\s+/)[0] ?? "0", 10);
    return Number.isFinite(kilobytes) ? kilobytes * 1024 : 0;
  } catch {
    return 0;
  }
}

function resolveCargoTargetPath() {
  let configText = "";
  try {
    configText = fs.readFileSync(cargoConfigPath, "utf8");
  } catch {
    return defaultCargoTargetPath;
  }
  return (
    parseCargoTargetDir(configText, os.homedir()) ?? defaultCargoTargetPath
  );
}

function blockingProcessesFor(targetPath) {
  const result = spawnSync("ps", ["-Ao", "pid=,comm="], { encoding: "utf8" });
  if (result.status !== 0) return [];
  return findBlockingProcesses(result.stdout, targetPath);
}

function hasCargoSweep() {
  const result = spawnSync("cargo-sweep", ["sweep", "--help"], {
    encoding: "utf8",
    stdio: "ignore",
  });
  if (result.status === 0) return "cargo-sweep";
  const vendored = path.join(cargoHome, "bin", "cargo-sweep");
  return fs.existsSync(vendored) ? vendored : null;
}

/**
 * Evict oldest artifacts until `targetPath` fits `keepGb`.
 * Returns bytes reclaimed.
 */
function sweepTargetDir(targetPath, keepGb, label) {
  const sweep = hasCargoSweep();
  const before = directorySizeBytes(targetPath);

  if (!sweep) {
    console.log(
      `${label}: ${formatBytes(before)} over limit but cargo-sweep is not installed.`
    );
    console.log(
      "  Install it with `cargo install cargo-sweep` so oldest artifacts can be evicted first."
    );
    return 0;
  }

  // `cargo-sweep`'s positional argument is a *cargo project* - it shells out
  // to `cargo metadata` there to discover the target dir. Passing the target
  // dir itself fails with "manifest path .../Cargo.toml does not exist".
  // Point it at the crate and override `CARGO_TARGET_DIR` so it resolves to
  // whichever target dir we actually want swept, shared or dual-build.
  const result = spawnSync(sweep, ["sweep", "--maxsize", `${keepGb}GB`, "."], {
    cwd: cargoProjectDir,
    env: { ...process.env, CARGO_TARGET_DIR: targetPath },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    console.log(`${label}: cargo-sweep failed, left untouched.`);
    if (result.stderr) console.log(`  ${result.stderr.trim().split("\n")[0]}`);
    return 0;
  }

  const after = directorySizeBytes(targetPath);
  const freed = Math.max(0, before - after);
  console.log(
    `${label}: swept ${formatBytes(before)} -> ${formatBytes(after)} (freed ${formatBytes(freed)}, cap ${keepGb}GB)`
  );
  return freed;
}

/**
 * `cargo-sweep` only understands Cargo target dirs. The webpack pack cache is
 * namespaced per build mode; drop whole namespaces rather than the parent so
 * an in-flight dev server keeps its own pack.
 */
function trimWebpackCache(cachePath, limitBytes) {
  const size = directorySizeBytes(cachePath);
  if (!isOverLimit(size, limitBytes)) return 0;

  const webpackDir = path.join(cachePath, "webpack");
  if (!fs.existsSync(webpackDir)) {
    fs.rmSync(cachePath, { recursive: true, force: true });
    console.log(`node_modules/.cache: removed ${formatBytes(size)}`);
    return size;
  }

  // Keep the most recently used namespace, drop the rest. The active dev
  // server touches its pack on every rebuild, so mtime is a good proxy.
  const namespaces = fs
    .readdirSync(webpackDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const full = path.join(webpackDir, entry.name);
      return { name: entry.name, full, mtimeMs: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  let freed = 0;
  for (const namespace of namespaces.slice(1)) {
    const namespaceSize = directorySizeBytes(namespace.full);
    fs.rmSync(namespace.full, { recursive: true, force: true });
    freed += namespaceSize;
    console.log(
      `webpack cache: dropped stale namespace ${namespace.name} (${formatBytes(namespaceSize)})`
    );
  }

  if (freed === 0) {
    console.log(
      `node_modules/.cache: ${formatBytes(size)} over limit but only one live namespace; leaving it.`
    );
  }
  return freed;
}

/**
 * Worktrees deleted with `git worktree remove` leave their
 * `CARGO_TARGET_DIR` behind in /tmp. Nothing owns those bytes afterwards.
 */
function removeOrphanedTmpTargets(minAgeDays) {
  const tmpRoot = "/private/tmp";
  if (!fs.existsSync(tmpRoot)) return 0;

  const live = new Set();
  const worktrees = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (worktrees.status === 0) {
    for (const line of worktrees.stdout.split("\n")) {
      if (line.startsWith("worktree ")) live.add(line.slice(9).trim());
    }
  }

  const cutoffMs = Date.now() - minAgeDays * 24 * 60 * 60 * 1000;
  let freed = 0;

  for (const entry of fs.readdirSync(tmpRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("orgii-")) continue;
    const full = path.join(tmpRoot, entry.name);

    // Only ever touch real Cargo target dirs, never a live worktree.
    if (!fs.existsSync(path.join(full, "CACHEDIR.TAG"))) continue;
    if ([...live].some((wt) => wt === full || wt.startsWith(`${full}/`)))
      continue;

    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.mtimeMs > cutoffMs) continue;

    const size = directorySizeBytes(full);
    fs.rmSync(full, { recursive: true, force: true });
    freed += size;
    console.log(`orphaned target: removed ${full} (${formatBytes(size)})`);
  }
  return freed;
}

/**
 * Decide which worktrees may be reaped.
 *
 * A worktree is only safe to remove when it has no uncommitted changes AND
 * its branch is already contained in the integration branch - otherwise the
 * removal would destroy the only copy of someone's work. The main worktree
 * is never a candidate.
 *
 * `entries` is [{ path, branch, isMain, isDirty, isMerged }].
 */
function selectReapableWorktrees(entries, protectedPaths = []) {
  return entries.filter((entry) => {
    if (entry.isMain || entry.isDirty || !entry.isMerged) return false;
    return !protectedPaths.some(
      (protectedPath) =>
        entry.path === protectedPath ||
        entry.path.startsWith(`${protectedPath}/`)
    );
  });
}

/**
 * `s-<hash>-working` is the session dir rustc creates at the start of a build
 * and atomically renames to `-finalized` on success. A killed rustc (Ctrl+C,
 * OOM, `tauri:dev` shutting down) orphans it, and a later cargo GC racing a
 * live sibling produces:
 *
 *   error: failed to create dependency graph at `.../s-...-working/
 *   dep-graph.part.bin`: No such file or directory (os error 2)
 *
 * Removing them is always safe - they are never read across builds, only the
 * `-finalized` siblings are.
 */
function pruneStaleIncrementalDirs(targetPath, label) {
  let removed = 0;
  for (const profile of ["debug", "release"]) {
    const incrementalDir = path.join(targetPath, profile, "incremental");
    if (!fs.existsSync(incrementalDir)) continue;

    for (const entry of fs.readdirSync(incrementalDir, {
      withFileTypes: true,
    })) {
      if (!entry.name.endsWith("-working")) continue;
      const full = path.join(incrementalDir, entry.name);
      fs.rmSync(full, { recursive: true, force: true });
      // Cargo holds the paired lock only for the working session's lifetime.
      fs.rmSync(`${full}.lock`, { force: true });
      removed += 1;
    }
  }
  if (removed > 0) {
    console.log(`${label}: pruned ${removed} stale -working dir(s)`);
  }
  return removed;
}

/**
 * Extracted crate sources, downloaded tarballs and git checkouts are all
 * re-fetched on demand. The sparse index is deliberately kept: it is small
 * and slow to rebuild.
 */
function pruneGlobalCargoCaches() {
  let freed = 0;
  const disposable = [
    [path.join(cargoHome, "registry", "src"), "registry/src"],
    [path.join(cargoHome, "registry", "cache"), "registry/cache"],
    [path.join(cargoHome, "git", "checkouts"), "git/checkouts"],
  ];
  for (const [dir, label] of disposable) {
    if (!fs.existsSync(dir)) continue;
    const size = directorySizeBytes(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    freed += size;
    console.log(`${label}: removed ${formatBytes(size)}`);
  }
  return freed;
}

/* ------------------------------------------------------------------ */

function pnpmStorePath() {
  const result = spawnSync("pnpm", ["store", "path"], { encoding: "utf8" });
  if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  return path.join(os.homedir(), "Library", "pnpm", "store");
}

/**
 * User-level caches shared with every other project on the machine. They are
 * reported unconditionally but only pruned under `--full`, because clearing
 * them slows down unrelated work too.
 */
function globalCacheRows() {
  return [
    ["pnpm store", pnpmStorePath()],
    ["npm cache", path.join(os.homedir(), ".npm")],
    ["rustup toolchains", path.join(os.homedir(), ".rustup", "toolchains")],
    ["cargo registry", path.join(cargoHome, "registry")],
  ];
}

/**
 * pnpm and npm both maintain content-addressed stores that only grow. Their
 * own prune commands are reference-aware, so installed projects keep working.
 */
function pruneNodePackageStores() {
  let freed = 0;

  const storePath = pnpmStorePath();
  const storeBefore = directorySizeBytes(storePath);
  if (storeBefore > 0) {
    const pruned = spawnSync("pnpm", ["store", "prune"], { encoding: "utf8" });
    if (pruned.status === 0) {
      const storeFreed = Math.max(
        0,
        storeBefore - directorySizeBytes(storePath)
      );
      freed += storeFreed;
      console.log(`pnpm store: freed ${formatBytes(storeFreed)}`);
    } else {
      console.log("pnpm store: prune failed, left untouched.");
    }
  }

  const npmCache = path.join(os.homedir(), ".npm", "_cacache");
  const npmBefore = directorySizeBytes(npmCache);
  if (npmBefore > 0) {
    const cleaned = spawnSync("npm", ["cache", "clean", "--force"], {
      encoding: "utf8",
    });
    if (cleaned.status === 0) {
      const npmFreed = Math.max(0, npmBefore - directorySizeBytes(npmCache));
      freed += npmFreed;
      console.log(`npm cache: freed ${formatBytes(npmFreed)}`);
    }
  }

  return freed;
}

/**
 * `cargo-sweep --maxsize` manages the artifact set (`deps/`, `build/`,
 * fingerprints) but never looks inside `incremental/`. On a shared target dir
 * that is where the bulk ends up: every crate keeps a session dir per query
 * hash, so a big crate rebuilt across several branches accumulates a
 * multi-GB dir per variant and nothing ever collects them.
 *
 * Incremental data is pure cache - deleting it only costs a slower next
 * build - so evict whole crate dirs, oldest first, until the target dir fits.
 */
function pruneIncrementalDirs(targetPath, keepBytes, label) {
  let freed = 0;

  for (const profile of ["debug", "release"]) {
    const incrementalDir = path.join(targetPath, profile, "incremental");
    if (!fs.existsSync(incrementalDir)) continue;

    let total = directorySizeBytes(targetPath);
    if (total <= keepBytes) break;

    const crateDirs = fs
      .readdirSync(incrementalDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const full = path.join(incrementalDir, entry.name);
        return { full, mtimeMs: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs);

    for (const crateDir of crateDirs) {
      if (total <= keepBytes) break;
      const size = directorySizeBytes(crateDir.full);
      fs.rmSync(crateDir.full, { recursive: true, force: true });
      freed += size;
      total -= size;
    }
  }

  if (freed > 0) {
    console.log(`${label}: evicted ${formatBytes(freed)} of incremental data`);
  }
  return freed;
}

/**
 * Stale worktrees are the upstream cause of target-dir sprawl: each one that
 * gets built adds a fresh set of crate hashes to the shared target dir, and
 * removing the worktree later does not remove those artifacts. Reaping merged
 * worktrees keeps the churn from starting.
 */
function reapMergedWorktrees(protectedPaths) {
  const listed = spawnSync("git", ["worktree", "list", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (listed.status !== 0) return 0;

  const integration =
    spawnSync("git", ["rev-parse", "--verify", "--quiet", "origin/develop"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).status === 0
      ? "origin/develop"
      : "origin/HEAD";

  const entries = [];
  let current = null;
  for (const line of listed.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice(9).trim(), branch: null };
      entries.push(current);
    } else if (line.startsWith("branch ") && current) {
      current.branch = line
        .slice(7)
        .trim()
        .replace(/^refs\/heads\//, "");
    }
  }

  const enriched = entries.map((entry, index) => {
    const status = spawnSync("git", ["status", "--porcelain"], {
      cwd: entry.path,
      encoding: "utf8",
    });
    const merged = entry.branch
      ? spawnSync(
          "git",
          ["merge-base", "--is-ancestor", entry.branch, integration],
          { cwd: repoRoot, encoding: "utf8" }
        ).status === 0
      : false;
    return {
      ...entry,
      isMain: index === 0,
      // A worktree we cannot inspect is treated as dirty, never as reapable.
      isDirty: status.status !== 0 || status.stdout.trim().length > 0,
      isMerged: merged,
    };
  });

  const reapable = selectReapableWorktrees(enriched, protectedPaths);
  let freed = 0;
  for (const entry of reapable) {
    const size = directorySizeBytes(entry.path);
    const removed = spawnSync(
      "git",
      ["worktree", "remove", "--force", entry.path],
      { cwd: repoRoot, encoding: "utf8" }
    );
    if (removed.status === 0) {
      freed += size;
      console.log(
        `worktree: removed ${entry.branch} (${formatBytes(size)}) - already in ${integration}`
      );
    }
  }
  if (reapable.length > 0) {
    spawnSync("git", ["worktree", "prune"], { cwd: repoRoot });
  }
  return freed;
}

function cargoTargetRows() {
  return [
    ["cargo shared-target", resolveCargoTargetPath(), limits.cargoTargetBytes],
    ["cargo shared-target-ra", rustAnalyzerTargetPath, limits.cargoTargetBytes],
    ...["target", "target-instance2"].map((name) => [
      `src-tauri/${name}`,
      path.join(repoRoot, "src-tauri", name),
      limits.dualTargetBytes,
    ]),
  ];
}

function main(argv) {
  const reportOnly = argv.includes("--report");
  const force = argv.includes("--force");
  const staleOnly = argv.includes("--stale");
  const full = argv.includes("--full");
  const worktrees = argv.includes("--worktrees");
  const nodeCacheOnly = argv.includes("--node-cache");
  const protectedPaths = (process.env.ORGII_PROTECTED_WORKTREES || "")
    .split(":")
    .filter(Boolean);

  const nodeCachePath = path.join(repoRoot, "node_modules", ".cache");
  const targetRows = cargoTargetRows();

  if (nodeCacheOnly) {
    const size = directorySizeBytes(nodeCachePath);
    fs.rmSync(nodeCachePath, { recursive: true, force: true });
    console.log(`node_modules/.cache: removed ${formatBytes(size)}`);
    return 0;
  }

  const rows = [
    ["node_modules/.cache", nodeCachePath, limits.nodeCacheBytes],
    ...targetRows,
  ];

  console.log("=== dev cache sizes ===");
  for (const [label, dir, limit] of rows) {
    const size = directorySizeBytes(dir);
    const state = size === 0 ? "-" : isOverLimit(size, limit) ? "OVER" : "ok";
    console.log(
      `  ${label.padEnd(24)} ${formatBytes(size).padStart(8)}  (limit ${formatBytes(limit)})  ${state}`
    );
  }

  // Shared with every project on the machine, so these are never touched by
  // the automatic path - only reported, and pruned on an explicit --full.
  console.log("--- shared with other projects (prune with --full) ---");
  for (const [label, dir] of globalCacheRows()) {
    const size = directorySizeBytes(dir);
    if (size === 0) continue;
    console.log(`  ${label.padEnd(24)} ${formatBytes(size).padStart(8)}`);
  }

  if (reportOnly) {
    console.log("\n--report: nothing removed.");
    return 0;
  }

  console.log("");

  // Stale `-working` dirs are never read across builds, so pruning them needs
  // no size check and no rebuild. This is the cheap fix for the recurring
  // "dep-graph.part.bin: No such file" error.
  if (staleOnly) {
    let pruned = 0;
    for (const [label, dir] of targetRows) {
      pruned += pruneStaleIncrementalDirs(dir, label);
    }
    console.log(
      pruned > 0
        ? "\nDone. No recompile needed."
        : "\nNo stale -working dirs found."
    );
    return 0;
  }

  let freed = 0;
  freed += trimWebpackCache(nodeCachePath, limits.nodeCacheBytes);

  // Order matters: reap merged worktrees first so their abandoned target dirs
  // become orphans that the next step can collect in the same run.
  if (full || worktrees) {
    freed += reapMergedWorktrees(protectedPaths);
  }
  freed += removeOrphanedTmpTargets(limits.orphanMinAgeDays);

  for (const [label, dir, limit] of targetRows) {
    const size = directorySizeBytes(dir);
    if (size === 0) continue;

    const blockers = force ? [] : blockingProcessesFor(dir);
    if (blockers.length > 0) {
      // Pruning stale `-working` dirs stays safe even mid-build, so still do
      // that much before backing off the size-based sweep.
      pruneStaleIncrementalDirs(dir, label);
      if (isOverLimit(size, limit)) {
        console.log(
          `${label}: ${formatBytes(size)} over limit, but skipping sweep - ${blockers[0].reason}.`
        );
        for (const blocker of blockers.slice(0, 3)) {
          console.log(`  pid ${blocker.pid} ${blocker.command}`);
        }
        console.log("  Stop the dev session and re-run, or pass --force.");
      }
      continue;
    }

    pruneStaleIncrementalDirs(dir, label);
    if (isOverLimit(size, limit)) {
      freed += sweepTargetDir(dir, limits.cargoKeepGb, label);
      // cargo-sweep stops at the artifact set; incremental/ is usually what
      // is still holding the space afterwards.
      freed += pruneIncrementalDirs(dir, limits.cargoKeepGb * GB, label);
    }
  }

  if (full) {
    console.log("");
    // rustc reads extracted crate sources out of `registry/src` *during*
    // compilation, so this prune is only safe when nothing is building.
    const registryBlockers = force
      ? []
      : blockingProcessesFor(resolveCargoTargetPath());
    if (registryBlockers.length > 0) {
      console.log(
        `global cargo cache: skipping prune - ${registryBlockers[0].reason}.`
      );
    } else {
      freed += pruneGlobalCargoCaches();
    }
    freed += pruneNodePackageStores();
  }

  console.log(
    freed > 0 ? `\nReclaimed ${formatBytes(freed)}.` : "\nNothing to reclaim."
  );
  return 0;
}

module.exports = {
  parseCargoTargetDir,
  findBlockingProcesses,
  isOverLimit,
  formatBytes,
  selectReapableWorktrees,
};

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
