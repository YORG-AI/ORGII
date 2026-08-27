const assert = require("node:assert/strict");
const test = require("node:test");

const {
  parseCargoTargetDir,
  findBlockingProcesses,
  isOverLimit,
  formatBytes,
} = require("./clean-cache-if-large.js");

test("parseCargoTargetDir reads [build] target-dir", () => {
  const config = [
    "[build]",
    'target-dir = "/Users/dev/.cargo/shared-target"',
    "jobs = 4",
  ].join("\n");
  assert.equal(
    parseCargoTargetDir(config, "/Users/dev"),
    "/Users/dev/.cargo/shared-target"
  );
});

test("parseCargoTargetDir expands a leading tilde", () => {
  assert.equal(
    parseCargoTargetDir('target-dir = "~/.cargo/shared-target"', "/Users/dev"),
    "/Users/dev/.cargo/shared-target"
  );
});

test("parseCargoTargetDir does not expand a tilde mid-path", () => {
  assert.equal(
    parseCargoTargetDir('target-dir = "/mnt/~backup/target"', "/Users/dev"),
    "/mnt/~backup/target"
  );
});

test("parseCargoTargetDir returns null when unset so the caller can default", () => {
  assert.equal(parseCargoTargetDir("[build]\njobs = 4", "/Users/dev"), null);
  assert.equal(parseCargoTargetDir("", "/Users/dev"), null);
  assert.equal(parseCargoTargetDir(undefined, "/Users/dev"), null);
});

test("findBlockingProcesses flags a running compiler", () => {
  const ps = ["101 /Users/dev/.rustup/bin/cargo", "102 /usr/bin/vim"].join(
    "\n"
  );
  const blockers = findBlockingProcesses(ps, "/Users/dev/.cargo/shared-target");
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].pid, "101");
  assert.equal(blockers[0].reason, "compiler running");
});

test("findBlockingProcesses flags a binary running out of the target dir", () => {
  // The regression the original script missed: `tauri:dev` runs the app
  // straight out of the shared target dir, and it is neither cargo nor rustc.
  const ps = "47877 /Users/dev/.cargo/shared-target/debug/org2";
  const blockers = findBlockingProcesses(ps, "/Users/dev/.cargo/shared-target");
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].reason, "binary running from target dir");
});

test("findBlockingProcesses ignores a sibling dir with a shared prefix", () => {
  const ps = "500 /Users/dev/.cargo/shared-target-ra/debug/other";
  assert.deepEqual(
    findBlockingProcesses(ps, "/Users/dev/.cargo/shared-target"),
    []
  );
});

test("findBlockingProcesses ignores unrelated processes and blank lines", () => {
  const ps = [
    "",
    "  ",
    "300 /Applications/Safari.app/Contents/MacOS/Safari",
  ].join("\n");
  assert.deepEqual(
    findBlockingProcesses(ps, "/Users/dev/.cargo/shared-target"),
    []
  );
  assert.deepEqual(
    findBlockingProcesses(undefined, "/Users/dev/.cargo/shared-target"),
    []
  );
});

test("isOverLimit is exclusive so a cache exactly at the cap is left alone", () => {
  assert.equal(isOverLimit(100, 100), false);
  assert.equal(isOverLimit(101, 100), true);
  assert.equal(isOverLimit(0, 100), false);
});

test("formatBytes picks a readable unit", () => {
  assert.equal(formatBytes(5 * 1024 * 1024 * 1024), "5.0GB");
  assert.equal(formatBytes(700 * 1024 * 1024), "700MB");
  assert.equal(formatBytes(2048), "2KB");
});

const { selectReapableWorktrees } = require("./clean-cache-if-large.js");

const worktree = (overrides) => ({
  path: "/tmp/wt",
  branch: "dev/thing",
  isMain: false,
  isDirty: false,
  isMerged: true,
  ...overrides,
});

test("selectReapableWorktrees reaps a clean, already-merged worktree", () => {
  const reapable = selectReapableWorktrees([worktree({})]);
  assert.equal(reapable.length, 1);
  assert.equal(reapable[0].branch, "dev/thing");
});

test("selectReapableWorktrees never reaps the main worktree", () => {
  assert.deepEqual(selectReapableWorktrees([worktree({ isMain: true })]), []);
});

test("selectReapableWorktrees keeps a worktree with uncommitted changes", () => {
  assert.deepEqual(selectReapableWorktrees([worktree({ isDirty: true })]), []);
});

test("selectReapableWorktrees keeps an unmerged branch", () => {
  // The branch may hold the only copy of that work - a local-only branch with
  // no remote is exactly the case that must survive.
  assert.deepEqual(
    selectReapableWorktrees([worktree({ isMerged: false })]),
    []
  );
});

test("selectReapableWorktrees honours protected paths, including nested ones", () => {
  const entries = [
    worktree({ path: "/tmp/session/wt" }),
    worktree({ path: "/tmp/other", branch: "dev/other" }),
  ];
  const reapable = selectReapableWorktrees(entries, ["/tmp/session"]);
  assert.equal(reapable.length, 1);
  assert.equal(reapable[0].path, "/tmp/other");
});

test("selectReapableWorktrees does not treat a path prefix as protected", () => {
  const reapable = selectReapableWorktrees(
    [worktree({ path: "/tmp/session2" })],
    ["/tmp/session"]
  );
  assert.equal(reapable.length, 1);
});
