/**
 * restore-checkpoint-diff-reconcile.spec.mjs
 *
 * Rendered-UI coverage for the restore-to-checkpoint → orgtrack ledger
 * reconciliation path (the "Diff (N) 残影" bug).
 *
 * The Workstation "Diff (N)" panel reads orgtrack's own tables
 * (`final_diffs` / `edit_artifacts` / `diff_chunks` / `file_changes`), a
 * separate ledger from the session event log. Before the fix,
 * restore-to-checkpoint truncated the event log + reverted files but never
 * touched the orgtrack ledger, so the panel kept listing every file the
 * session had ever edited — even ones the restore just reverted ("残影").
 *
 * The fix (src/engines/ChatPanel/ChatHistory/hooks/useRestoreCheckpoint.ts):
 * after truncating the session-persistence `events` cache, restore now calls
 * `analyzeOrgtrackSessions({ sessionId, rebuild: true })`, which re-derives all
 * four orgtrack tables from the (now-truncated) event stream. With the events
 * cache empty after restore, the residue final-diff rows must drop to zero.
 *
 * This spec drives the REAL production path (no live LLM):
 *   1. Seed a chat with a user message (so the restore button renders) in a
 *      non-agent/non-cli session id, so the restore handler skips the
 *      agent/cli backend truncate and exercises the cache-truncate + reanalyze
 *      branch directly.
 *   2. Seed an orgtrack final-diff residue row via the debug-only
 *      `debugSeedFinalDiffWire`, and assert it is present
 *      (`debugReadFinalDiffCountWire` === 1).
 *   3. Click the rendered `chat-message-restore-checkpoint` button.
 *   4. Assert the orgtrack final-diffs ledger reconciles to 0 — proving the
 *      restore handler fired the reanalyze that clears the 残影.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MOUNT_TIMEOUT_MS = 60_000;
const RENDER_TIMEOUT_MS = 12_000;
const RECONCILE_TIMEOUT_MS = 30_000;
const RUN_ID = Date.now();

const SEEDED_FILE_PATH = "src/restore-sentinel.ts";
// orgtrack's canonical source for ORGII Rust-agent sessions. The reanalyze
// path loads this source's events from the session-persistence `events` cache
// and deletes the session's artifacts when that cache is empty — which is what
// restore-to-checkpoint produces after truncation.
const ORGII_RUST_AGENTS_SOURCE = "orgii_rust_agents";

async function execJS(script) {
  return browser.executeScript(script, []);
}

// Isolated E2E homes boot to the login page; set the BYOK soft-pass flag so
// AuthGuard/AuthRedirect treat the session as authorized.
async function ensureAuthBypass() {
  await execJS(`
    localStorage.setItem("orgii:auth_skipped", "1");
    localStorage.setItem("orgii:e2eBaseUrl", ${JSON.stringify(
      process.env.E2E_BASE_URL ?? "http://127.0.0.1:13847"
    )});
    return true;
  `).catch(() => undefined);
}

async function invokeE2E(method, ...args) {
  return browser.executeAsyncScript(
    `
    const cb = arguments[arguments.length - 1];
    const method = arguments[0];
    const rest = Array.prototype.slice.call(arguments, 1, arguments.length - 1);
    if (!window.__e2e || typeof window.__e2e[method] !== "function") {
      cb({ ok: false, error: "window.__e2e." + method + " not available" });
      return;
    }
    Promise.resolve(window.__e2e[method].apply(null, rest))
      .then(cb)
      .catch((e) => cb({ ok: false, error: String(e && e.message || e) }));
  `,
    [method, ...args]
  );
}

function unwrap(result, label) {
  if (!result || result.ok !== true) {
    throw new Error(`${label} failed: ${result?.error ?? "unknown"}`);
  }
  return result;
}

async function waitForApp() {
  await browser.setWindowSize(2400, 1200).catch(() => undefined);
  await browser.waitUntil(
    async () => {
      try {
        return await execJS(
          `return !!(window.__e2e && window.__e2e.seedChatEvents &&
            window.__e2e.ensureRepoSelected &&
            window.__e2e.debugSeedFinalDiffWire &&
            window.__e2e.debugReadFinalDiffCountWire);`
        );
      } catch {
        return false;
      }
    },
    {
      timeout: MOUNT_TIMEOUT_MS,
      timeoutMsg: "window.__e2e seed/read helpers never exposed",
    }
  );
}

function git(repoPath, args) {
  execFileSync(
    "git",
    [
      "-C",
      repoPath,
      "-c",
      "user.name=ORGII E2E",
      "-c",
      "user.email=e2e@orgii.local",
      ...args,
    ],
    { stdio: "ignore" }
  );
}

function createFixtures() {
  const root = mkdtempSync(join(tmpdir(), "orgii-e2e-restore-reconcile-"));
  const gitRepoPath = join(root, "repo");
  mkdirSync(gitRepoPath, { recursive: true });
  execFileSync("git", ["init", "--initial-branch=main", gitRepoPath], {
    stdio: "ignore",
  });
  writeFileSync(
    join(gitRepoPath, "README.md"),
    "# restore-reconcile fixture\n"
  );
  git(gitRepoPath, ["add", "README.md"]);
  git(gitRepoPath, ["commit", "-m", "Initial"]);
  return { root, gitRepoPath };
}

// A user-message event whose `id` carries NO agent/cli prefix, so the restore
// handler's `isAgentSession`/`isCliSession` branches are both false and it
// exercises the cache-truncate + orgtrack-reanalyze path directly (the part
// the fix added) without needing a real agent_messages row.
function makeUserEvent(sessionId, repoPath, createdAt) {
  return {
    id: `${sessionId}-user`,
    chunk_id: `${sessionId}-user`,
    sessionId,
    createdAt,
    functionName: "user_message",
    uiCanonical: "user_message",
    actionType: "raw",
    args: {},
    result: { type: "user", message: "make a change", is_delta: false },
    source: "user",
    repoId: repoPath,
    repoPath,
    displayText: "restore me to here",
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "processed",
    isDelta: false,
  };
}

async function readFinalDiffCount(sessionId, label) {
  const result = await invokeE2E("debugReadFinalDiffCountWire", {
    sessionId,
    source: ORGII_RUST_AGENTS_SOURCE,
  });
  return unwrap(result, label).count;
}

// Click the restore-checkpoint button on the (single) seeded user message.
// The button is hover-revealed but still clickable via element.click().
async function clickRestoreCheckpoint() {
  return execJS(`
    const btn = document.querySelector('[data-testid="chat-message-restore-checkpoint"]');
    if (!btn) return { clicked: false };
    btn.click();
    return { clicked: true };
  `);
}

describe("Restore checkpoint / orgtrack Diff ledger reconciliation", function () {
  this.timeout(300_000);

  let fixtures;

  before(async () => {
    fixtures = createFixtures();
    await waitForApp();
    await ensureAuthBypass();
  });

  after(() => {
    if (fixtures?.root) {
      rmSync(fixtures.root, { force: true, recursive: true });
    }
  });

  beforeEach(async () => {
    await ensureAuthBypass();
    unwrap(
      await invokeE2E("navigateTo", "/orgii/workstation/code"),
      "navigateTo workstation code"
    );
    unwrap(await invokeE2E("resetToNewSession"), "resetToNewSession");
    unwrap(
      await invokeE2E("ensureRepoSelected", {
        repoPath: fixtures.gitRepoPath,
        repoName: "restore-reconcile-fixture",
      }),
      "ensureRepoSelected"
    );
  });

  it("clears the stale orgtrack final-diff residue when restoring to a checkpoint", async function () {
    const { gitRepoPath } = fixtures;
    // Non-agent/non-cli session id (no osagent-/sdeagent-/cli- prefix) so the
    // restore handler skips the backend message truncate and runs the
    // cache-truncate + orgtrack reanalyze branch the fix added.
    const sessionId = `e2e-restore-reconcile-${RUN_ID}`;
    const base = Date.now();

    // 1. Seed a chat with one user message so the restore button renders.
    unwrap(
      await invokeE2E(
        "seedChatEvents",
        sessionId,
        [makeUserEvent(sessionId, gitRepoPath, new Date(base).toISOString())],
        { stationMode: "my-station", chatPanelMaximized: true }
      ),
      "seedChatEvents"
    );

    // 2. Seed an orgtrack final-diff residue row (the 残影 a prior edit left).
    const unifiedDiff = [
      `--- ${SEEDED_FILE_PATH}`,
      `+++ ${SEEDED_FILE_PATH}`,
      `@@ -1,1 +1,1 @@`,
      `-const RESIDUE_${RUN_ID} = "before";`,
      `+const RESIDUE_${RUN_ID} = "after";`,
    ].join("\n");
    unwrap(
      await invokeE2E("debugSeedFinalDiffWire", {
        sessionId,
        source: ORGII_RUST_AGENTS_SOURCE,
        filePath: SEEDED_FILE_PATH,
        diff: unifiedDiff,
      }),
      "debugSeedFinalDiffWire"
    );

    // 2a. Confirm the residue is present before restore.
    await browser.waitUntil(
      async () => (await readFinalDiffCount(sessionId, "seed-check")) >= 1,
      {
        timeout: RENDER_TIMEOUT_MS,
        interval: 500,
        timeoutMsg: `seeded orgtrack final-diff residue never became visible (expected >=1); count=${await readFinalDiffCount(
          sessionId,
          "seed-check-final"
        )}`,
      }
    );

    // 3. Wait for the restore button to render on the seeded user message,
    //    then click it.
    await browser.waitUntil(
      async () => {
        const present = await execJS(
          `return !!document.querySelector('[data-testid="chat-message-restore-checkpoint"]');`
        );
        return present;
      },
      {
        timeout: RENDER_TIMEOUT_MS,
        interval: 500,
        timeoutMsg:
          "restore-checkpoint button never rendered on the seeded user message",
      }
    );
    unwrap(
      (await clickRestoreCheckpoint()).clicked
        ? { ok: true }
        : { ok: false, error: "restore-checkpoint button not clickable" },
      "clickRestoreCheckpoint"
    );

    // 4. The fix: restore truncates the events cache and reanalyzes orgtrack
    //    with rebuild=true. With the post-checkpoint event stream carrying no
    //    edits, the residue final-diff rows must be re-derived away to 0.
    //    Before the fix the ledger was never touched and stayed at 1 ("残影").
    await browser.waitUntil(
      async () => (await readFinalDiffCount(sessionId, "after-restore")) === 0,
      {
        timeout: RECONCILE_TIMEOUT_MS,
        interval: 1_000,
        timeoutMsg: `orgtrack final-diff ledger did not reconcile to 0 after restore (stale 残影 remains); count=${await readFinalDiffCount(
          sessionId,
          "after-restore-final"
        )}`,
      }
    );
  });
});
