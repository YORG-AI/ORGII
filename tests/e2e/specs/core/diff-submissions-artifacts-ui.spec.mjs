/**
 * diff-submissions-artifacts-ui.spec.mjs
 *
 * Rendered-UI coverage for the git-artifact → Diff/Submissions surfaces that
 * the 2026-06-15 work touched:
 *
 *   1. PUSH commit  — an orgtrack commit link (the artifact `collect_push_output`
 *      writes from a `git push` summary) surfaces the pushed commit in the
 *      Diff app's Submissions tab, resolved against real git history (subject +
 *      short sha), and is individually clickable to open its diff detail.
 *   2. PR submission — a `gh pr create` shell event whose gitArtifacts carry a
 *      pullRequest surfaces a PR row in the Submissions tab with its number.
 *   3. MISS          — clicking a chat commit card whose SHA exists in NO
 *      registered repo must NOT wedge the app (no permanent "Failed to load
 *      commit diff", workstation surface stays healthy).
 *
 * Push commits reach the Submissions tab through the orgtrack commit-link
 * path (backend SQLite), NOT the front-end `submissionsData.commits` array
 * (which only feeds card navigation). We seed a real commit link via the
 * debug-only `debug_seed_commit_link` wire so the rendered path is identical
 * to a live push whose backfill has run.
 *
 * Each scenario drives the rendered click/seed path a user performs and
 * asserts an observable UI result, per the e2e-testing skill's rendered-UI
 * contract (layers 3 + ghost-action negative).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  execJS,
  invokeE2E,
  unwrap,
  waitForApp as waitForAppBase,
} from "../../support/core/session/agentQueuedFollowupDriver.mjs";

const MOUNT_TIMEOUT_MS = 60_000;
const RENDER_TIMEOUT_MS = 12_000;
const DIFF_DETAIL_TIMEOUT_MS = 30_000;
const RUN_ID = Date.now();

async function waitForApp() {
  // Shared driver handles login bypass / app mount.
  await waitForAppBase();
  await browser.setWindowSize(2400, 1200).catch(() => undefined);
  await browser.waitUntil(
    async () => {
      try {
        return await execJS(
          `return !!(window.__e2e && window.__e2e.seedChatEvents &&
            window.__e2e.ensureRepoSelected &&
            window.__e2e.openAgentStationDiff &&
            window.__e2e.debugSeedCommitLinkWire);`
        );
      } catch {
        return false;
      }
    },
    {
      timeout: MOUNT_TIMEOUT_MS,
      timeoutMsg: "window.__e2e seed/repo/diff helpers never exposed",
    }
  );
}

// ── Fixture: a real git repo with a couple of commits ───────────────────

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
  const root = mkdtempSync(join(tmpdir(), "orgii-e2e-diff-submissions-"));
  const gitRepoPath = join(root, "real-repo");
  mkdirSync(gitRepoPath, { recursive: true });

  execFileSync("git", ["init", "--initial-branch=main", gitRepoPath], {
    stdio: "ignore",
  });
  writeFileSync(join(gitRepoPath, "README.md"), "# diff submissions fixture\n");
  git(gitRepoPath, ["add", "README.md"]);
  git(gitRepoPath, ["commit", "-m", "Initial fixture commit"]);

  const pushSubject = `feat(e2e): pushed sentinel ${RUN_ID}`;
  writeFileSync(
    join(gitRepoPath, "pushed.ts"),
    `export const PUSHED_SENTINEL = ${RUN_ID};\n`
  );
  git(gitRepoPath, ["add", "pushed.ts"]);
  git(gitRepoPath, ["commit", "-m", pushSubject]);

  const pushedFullSha = execFileSync(
    "git",
    ["-C", gitRepoPath, "rev-parse", "HEAD"],
    { encoding: "utf8" }
  ).trim();
  const pushedShortSha = execFileSync(
    "git",
    ["-C", gitRepoPath, "rev-parse", "--short=8", "HEAD"],
    { encoding: "utf8" }
  ).trim();

  return { root, gitRepoPath, pushSubject, pushedFullSha, pushedShortSha };
}

// ── Event factories ─────────────────────────────────────────────────────

function makeUserEvent(sessionId, repoPath, createdAt, message) {
  return {
    id: `${sessionId}-user`,
    chunk_id: `${sessionId}-user`,
    sessionId,
    createdAt,
    functionName: "user_message",
    uiCanonical: "user_message",
    actionType: "raw",
    args: {},
    result: { type: "user", message, is_delta: false },
    source: "user",
    repoId: repoPath,
    repoPath,
    displayText: message,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "processed",
    isDelta: false,
  };
}

// A `git push` shell event. Its presence in the simulator timeline gives the
// Submissions resolver a repo context; the commit itself reaches the tab via
// the orgtrack commit-link path (seeded separately).
function makePushShellEvent(sessionId, repoPath, shortSha, createdAt) {
  const id = `${sessionId}-push`;
  return {
    id,
    chunk_id: id,
    sessionId,
    createdAt,
    functionName: "run_shell",
    uiCanonical: "run_shell",
    actionType: "tool_call",
    args: { command: "git push origin main" },
    result: {},
    source: "assistant",
    repoId: repoPath,
    repoPath,
    displayText: "git push origin main",
    displayStatus: "completed",
    displayVariant: "tool_call",
    activityStatus: "agent",
    isDelta: false,
    extracted: {
      kind: "shell",
      command: "git push origin main",
      output: `To github.com:orgii/app.git\n   0000000..${shortSha}  main -> main\n`,
      exitCode: 0,
      isFailure: false,
      gitArtifacts: [{ kind: "commit", sha: shortSha, shortSha }],
    },
  };
}

// A `gh pr create` shell event whose gitArtifacts carry a pull request.
function makePrShellEvent(sessionId, repoPath, prNumber, createdAt) {
  const id = `${sessionId}-pr`;
  const url = `https://github.com/orgii/app/pull/${prNumber}`;
  return {
    id,
    chunk_id: id,
    sessionId,
    createdAt,
    functionName: "run_shell",
    uiCanonical: "run_shell",
    actionType: "tool_call",
    args: { command: "gh pr create --fill" },
    result: {},
    source: "assistant",
    repoId: repoPath,
    repoPath,
    displayText: "gh pr create --fill",
    displayStatus: "completed",
    displayVariant: "tool_call",
    activityStatus: "agent",
    isDelta: false,
    extracted: {
      kind: "shell",
      command: "gh pr create --fill",
      output: `${url}\n`,
      exitCode: 0,
      isFailure: false,
      gitArtifacts: [
        { kind: "pullRequest", url, repoFullName: "orgii/app", prNumber },
      ],
    },
  };
}

// An assistant message that references a commit SHA (chat reference card path).
function makeAssistantCommitEvent(
  sessionId,
  repoPath,
  shortSha,
  subject,
  createdAt
) {
  const text = ["改动已提交：", "", `- \`${shortSha}\` ${subject}`].join("\n");
  const id = `${sessionId}-assistant`;
  return {
    id,
    chunk_id: id,
    sessionId,
    createdAt,
    functionName: "assistant_message",
    uiCanonical: "agent_message",
    actionType: "assistant",
    args: {},
    result: {
      content: text,
      observation: text,
      is_delta: false,
      role: "assistant",
    },
    source: "assistant",
    repoId: repoPath,
    repoPath,
    displayText: text,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "agent",
    isDelta: false,
  };
}

// ── DOM probes ──────────────────────────────────────────────────────────

const OPEN_LABELS = ["Open", "打开", "開啟"];
const FAILED_DIFF_TEXTS = [
  "Failed to load commit diff",
  "加载提交差异失败",
  "加載提交差異失敗",
];

// The Diff app renders the WorkStationShell with class `session-replay-diff`
// (NOT `session-replay-ide` — that's the CodeEditor app).
async function diffPanelSnapshot() {
  const dom = await execJS(`
    const replay = document.querySelector('.session-replay-diff');
    return {
      bodyText: (document.body.innerText || '').slice(0, 20000),
      replayText: replay ? (replay.innerText || '') : '',
      hasReplayShell: !!replay,
    };
  `);
  const surface = await invokeE2E("inspectWorkstationSurface");
  return { ...dom, surface };
}

// Tabs share testid `replay-tab-diff-filter` (Diff + Submissions both use
// kind "diff-filter"); they're distinguished by their stable `data-event-id`.
async function clickReplayTab(eventId) {
  return execJS(`
    const eventId = ${JSON.stringify(eventId)};
    const tab = document.querySelector('[data-event-id="' + eventId + '"]');
    if (!tab) return { clicked: false };
    tab.click();
    return {
      clicked: true,
      selected: tab.getAttribute('aria-selected'),
      text: (tab.innerText || '').trim(),
    };
  `);
}

// The commit row (GitCommitRow) shows the SUBJECT as visible text and carries
// the short sha only in its `title` attribute. Click the row whose title or
// text identifies the target commit.
async function clickSubmissionCommit(subject, shortSha) {
  return execJS(`
    const subject = ${JSON.stringify(subject)};
    const shaPrefix = ${JSON.stringify(shortSha)}.slice(0, 7);
    const replay = document.querySelector('.session-replay-diff') || document;
    const rows = Array.from(
      replay.querySelectorAll('[title], button, [role="button"], div')
    ).filter((node) => {
      const title = node.getAttribute('title') || '';
      const text = node.innerText || '';
      return title.includes(shaPrefix) || (text.includes(subject) && text.length < 200);
    });
    rows.sort((a, b) => (a.innerText || '').length - (b.innerText || '').length);
    const row = rows[0] || null;
    if (!row) return { clicked: false };
    row.click();
    return { clicked: true, title: row.getAttribute('title') || '' };
  `);
}

async function commitCardOpen(shortSha) {
  return execJS(`
    const shaPrefix = ${JSON.stringify(shortSha)}.slice(0, 7);
    const openLabels = ${JSON.stringify(OPEN_LABELS)};
    const panel = document.querySelector('[data-testid="chat-panel"]') || document;
    const cards = Array.from(panel.querySelectorAll('div')).filter((node) =>
      node.className && String(node.className).includes('rounded-xl') &&
      (node.innerText || '').includes(shaPrefix)
    );
    const card = cards[cards.length - 1] || null;
    const openButton = card
      ? Array.from(card.querySelectorAll('button')).find((button) =>
          openLabels.includes(button.getAttribute('aria-label') || '')
        )
      : null;
    if (!openButton) return { hasCard: !!card, clicked: false };
    openButton.click();
    return { hasCard: true, clicked: true };
  `);
}

describe("Diff / Submissions git-artifact surfaces", function () {
  this.timeout(300_000);

  let fixtures;

  before(async () => {
    fixtures = createFixtures();
    await waitForApp();
  });

  after(() => {
    if (fixtures?.root) {
      rmSync(fixtures.root, { force: true, recursive: true });
    }
  });

  beforeEach(async () => {
    unwrap(
      await invokeE2E("navigateTo", "/orgii/workstation/code"),
      "navigateTo workstation code"
    );
    unwrap(await invokeE2E("resetToNewSession"), "resetToNewSession");
    unwrap(
      await invokeE2E("ensureRepoSelected", {
        repoPath: fixtures.gitRepoPath,
        repoName: "diff-submissions-fixture",
      }),
      "ensureRepoSelected"
    );
  });

  it("surfaces a pushed commit in the Submissions tab, individually clickable", async function () {
    const { gitRepoPath, pushedShortSha, pushSubject } = fixtures;
    const sessionId = `e2e-diff-push-${RUN_ID}`;
    const base = Date.now();

    unwrap(
      await invokeE2E(
        "seedChatEvents",
        sessionId,
        [
          makeUserEvent(
            sessionId,
            gitRepoPath,
            new Date(base).toISOString(),
            "push it"
          ),
          makePushShellEvent(
            sessionId,
            gitRepoPath,
            pushedShortSha,
            new Date(base + 1_000).toISOString()
          ),
        ],
        { stationMode: "agent-station" }
      ),
      "seedChatEvents push"
    );

    // The orgtrack commit-link path: this is what backfill writes from a real
    // push summary. Without it, the Submissions Commits list is empty.
    unwrap(
      await invokeE2E("debugSeedCommitLinkWire", {
        sessionId,
        commitSha: pushedShortSha,
      }),
      "debugSeedCommitLinkWire"
    );

    unwrap(await invokeE2E("openAgentStationDiff"), "openAgentStationDiff");

    await browser.waitUntil(
      async () => {
        const snap = await diffPanelSnapshot();
        return snap.hasReplayShell;
      },
      {
        timeout: RENDER_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: `replay shell never mounted: ${JSON.stringify(
          await diffPanelSnapshot()
        )}`,
      }
    );

    // The pushed commit resolves against the fixture repo and renders in the
    // Submissions tab with its real subject.
    await browser.waitUntil(
      async () => {
        await clickReplayTab("diff-tab:submissions");
        const snap = await diffPanelSnapshot();
        return snap.replayText.includes(pushSubject);
      },
      {
        timeout: DIFF_DETAIL_TIMEOUT_MS,
        interval: 500,
        timeoutMsg: `pushed commit subject never rendered in Submissions: ${JSON.stringify(
          await diffPanelSnapshot()
        )}`,
      }
    );

    // Individually clickable → opens the commit's diff detail (the fixture's
    // pushed.ts sentinel file is part of that commit).
    await browser.waitUntil(
      async () => {
        await clickSubmissionCommit(pushSubject, pushedShortSha);
        const snap = await diffPanelSnapshot();
        return (
          snap.bodyText.includes("pushed.ts") ||
          snap.bodyText.includes("PUSHED_SENTINEL")
        );
      },
      {
        timeout: DIFF_DETAIL_TIMEOUT_MS,
        interval: 750,
        timeoutMsg: `commit diff detail never opened: ${JSON.stringify(
          await diffPanelSnapshot()
        )}`,
      }
    );
  });

  it("surfaces a pull request in the Submissions tab", async function () {
    const { gitRepoPath } = fixtures;
    const sessionId = `e2e-diff-pr-${RUN_ID}`;
    const prNumber = 4576;
    const base = Date.now();

    unwrap(
      await invokeE2E(
        "seedChatEvents",
        sessionId,
        [
          makeUserEvent(
            sessionId,
            gitRepoPath,
            new Date(base).toISOString(),
            "open a PR"
          ),
          makePrShellEvent(
            sessionId,
            gitRepoPath,
            prNumber,
            new Date(base + 1_000).toISOString()
          ),
        ],
        { stationMode: "agent-station" }
      ),
      "seedChatEvents pr"
    );

    unwrap(await invokeE2E("openAgentStationDiff"), "openAgentStationDiff");

    await browser.waitUntil(
      async () => {
        await clickReplayTab("diff-tab:submissions");
        const snap = await diffPanelSnapshot();
        return snap.bodyText.includes(`#${prNumber}`);
      },
      {
        timeout: DIFF_DETAIL_TIMEOUT_MS,
        interval: 500,
        timeoutMsg: `PR #${prNumber} never rendered in Submissions: ${JSON.stringify(
          await diffPanelSnapshot()
        )}`,
      }
    );
  });

  it("does not wedge the app when a referenced commit SHA is unknown", async function () {
    const { gitRepoPath } = fixtures;
    const sessionId = `e2e-diff-miss-${RUN_ID}`;
    // A SHA that exists in NO repo. Must carry ≥2 digits + an a–f letter so
    // the front-end auto-detection (`looksLikeAutoDetectedSha`) treats it as a
    // commit rather than a stray hex token.
    const missingShortSha = "dead1234";
    const missingSubject = `feat(e2e): phantom commit ${RUN_ID}`;
    const base = Date.now();

    unwrap(
      await invokeE2E(
        "seedChatEvents",
        sessionId,
        [
          makeUserEvent(
            sessionId,
            gitRepoPath,
            new Date(base).toISOString(),
            "show me that commit"
          ),
          makeAssistantCommitEvent(
            sessionId,
            gitRepoPath,
            missingShortSha,
            missingSubject,
            new Date(base + 1_000).toISOString()
          ),
        ],
        { chatPanelMaximized: true }
      ),
      "seedChatEvents miss"
    );

    await browser.waitUntil(
      async () => {
        const snap = await diffPanelSnapshot();
        return snap.bodyText.includes(missingShortSha.slice(0, 7));
      },
      {
        timeout: RENDER_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: `assistant message with missing sha never rendered: ${JSON.stringify(
          await diffPanelSnapshot()
        )}`,
      }
    );

    const click = await commitCardOpen(missingShortSha);
    if (!click?.hasCard) {
      throw new Error("commit card for unknown SHA never rendered");
    }
    // The card may resolve no diff — that's expected. The contract is: no
    // permanent "Failed to load commit diff", workstation stays usable.
    await browser.pause(3_000);
    const finalSnap = await diffPanelSnapshot();
    const failedText = FAILED_DIFF_TEXTS.find((text) =>
      finalSnap.bodyText.includes(text)
    );
    if (failedText) {
      throw new Error(
        `Diff panel shows ${JSON.stringify(failedText)} for unknown SHA — should degrade gracefully`
      );
    }
    if (finalSnap.surface?.ok !== true) {
      throw new Error(
        `workstation surface unhealthy after unknown-SHA click: ${JSON.stringify(
          finalSnap.surface
        )}`
      );
    }
  });
});
