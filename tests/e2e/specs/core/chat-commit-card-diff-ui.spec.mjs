/**
 * chat-commit-card-diff-ui.spec.mjs
 *
 * Rendered-UI regression spec for the "old commit card → Failed to load
 * commit diff" bug (2026-06-12): a chat session whose working directory is
 * NOT a git repository (e.g. a plain source dump) produced assistant
 * messages referencing commits that actually live in a different,
 * registered workspace repo. Clicking the commit reference card routed the
 * session-level (non-git) repo context into GitCommitDetailContent, whose
 * backend lookup died with `could not find repository at '<non-git dir>'`.
 *
 * The fix (SessionReplayDiff submission resolution) searches the primary
 * session context first, then falls back to every repo registered in
 * `reposAtom`, and treats the repo where the SHA was actually found as the
 * authoritative context for the commit detail panel.
 *
 * This spec exercises the full user path from the rendered app:
 *   1. Register a real git fixture repo (reposAtom) + seed a chat session
 *      whose events carry a NON-git repoPath (the bug shape).
 *   2. Assert the commit reference card renders in chat with an Open action.
 *   3. Click Open — the same click path a user performs.
 *   4. Assert the Diff app resolves the commit against the fixture repo and
 *      renders the commit detail (file list + subject), and the
 *      "Failed to load commit diff" error placeholder never appears.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MOUNT_TIMEOUT_MS = 60_000;
const RENDER_TIMEOUT_MS = 12_000;
const DIFF_DETAIL_TIMEOUT_MS = 30_000;
const RUN_ID = Date.now();

const COMMIT_SUBJECT = `feat(e2e): add commit card sentinel ${RUN_ID}`;
const SENTINEL_FILE = "commit-card-sentinel.ts";

async function execJS(script) {
  return browser.executeScript(script, []);
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
  // The isolated home boots into the login page; bypass auth first so the
  // workstation (and chat panel) can mount.
  await browser.waitUntil(
    async () => {
      try {
        await execJS(`
          localStorage.setItem("orgii:auth_skipped", "1");
          localStorage.setItem("orgii:e2eBaseUrl", ${JSON.stringify(
            process.env.E2E_BASE_URL ?? "http://127.0.0.1:13847"
          )});
          if (location.pathname.includes("login")) {
            location.reload();
          }
          return true;
        `);
        return true;
      } catch {
        return false;
      }
    },
    { timeout: MOUNT_TIMEOUT_MS, timeoutMsg: "auth bypass never accepted" }
  );
  await browser.waitUntil(
    async () => {
      try {
        return await execJS(
          `return !!document.querySelector('[data-testid="chat-panel"]');`
        );
      } catch {
        return false;
      }
    },
    { timeout: MOUNT_TIMEOUT_MS, timeoutMsg: "chat-panel never mounted" }
  );
  await browser.waitUntil(
    async () => {
      try {
        return await execJS(
          `return !!(window.__e2e && window.__e2e.seedChatEvents && window.__e2e.ensureRepoSelected);`
        );
      } catch {
        return false;
      }
    },
    {
      timeout: 20_000,
      timeoutMsg: "window.__e2e seed/repo helpers never exposed",
    }
  );
}

// ── Fixture: a real git repo with one commit + a non-git session dir ────

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
  const root = mkdtempSync(join(tmpdir(), "orgii-e2e-commit-card-"));
  const gitRepoPath = join(root, "real-repo");
  const nonGitDirPath = join(root, "non-git-workdir");

  mkdirSync(gitRepoPath, { recursive: true });
  mkdirSync(nonGitDirPath, { recursive: true });
  writeFileSync(
    join(nonGitDirPath, "notes.txt"),
    "plain working directory without .git\n"
  );

  execFileSync("git", ["init", "--initial-branch=main", gitRepoPath], {
    stdio: "ignore",
  });
  writeFileSync(join(gitRepoPath, "README.md"), "# commit card fixture\n");
  git(gitRepoPath, ["add", "README.md"]);
  git(gitRepoPath, ["commit", "-m", "Initial fixture commit"]);

  writeFileSync(
    join(gitRepoPath, SENTINEL_FILE),
    `export const COMMIT_CARD_SENTINEL = ${RUN_ID};\n`
  );
  git(gitRepoPath, ["add", SENTINEL_FILE]);
  git(gitRepoPath, ["commit", "-m", COMMIT_SUBJECT]);

  const shortSha = execFileSync(
    "git",
    ["-C", gitRepoPath, "rev-parse", "--short=12", "HEAD"],
    { encoding: "utf8" }
  ).trim();

  return { root, gitRepoPath, nonGitDirPath, shortSha };
}

// ── Event factories (bug shape: events carry the NON-git repoPath) ──────

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
    result: { type: "user", message: "推吧", is_delta: false },
    source: "user",
    repoId: repoPath,
    repoPath,
    displayText: "推吧",
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "processed",
    isDelta: false,
  };
}

function makeAssistantCommitEvent(sessionId, repoPath, shortSha, createdAt) {
  const text = [
    "改动已经提交并推送了：",
    "",
    `- \`${shortSha}\` ${COMMIT_SUBJECT}`,
  ].join("\n");
  return {
    id: `${sessionId}-assistant`,
    chunk_id: `${sessionId}-assistant`,
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

// The isolated home may run any locale; match both English and Chinese.
const OPEN_LABELS = ["Open", "打开", "開啟"];
const FAILED_DIFF_TEXTS = [
  "Failed to load commit diff",
  "加载提交差异失败",
  "加載提交差異失敗",
];

async function commitCardState(shortSha) {
  return execJS(`
    // After git metadata resolution the card may display the backend's
    // 7-char short SHA, so match cards on the 7-char prefix.
    const shaPrefix = ${JSON.stringify(shortSha)}.slice(0, 7);
    const openLabels = ${JSON.stringify(OPEN_LABELS)};
    const panel = document.querySelector('[data-testid="chat-panel"]');
    const body = panel ? (panel.innerText || '') : '';
    const cards = Array.from(
      (panel || document).querySelectorAll('div')
    ).filter((node) =>
      node.className && String(node.className).includes('rounded-xl') &&
      (node.innerText || '').includes(shaPrefix)
    );
    const card = cards[cards.length - 1] || null;
    const openButton = card
      ? Array.from(card.querySelectorAll('button')).find((button) =>
          openLabels.includes(button.getAttribute('aria-label') || '')
        )
      : null;
    return {
      bodyHasSha: body.includes(shaPrefix),
      hasCard: !!card,
      hasOpenButton: !!openButton,
    };
  `);
}

async function clickCommitCardOpen(shortSha) {
  return execJS(`
    const shaPrefix = ${JSON.stringify(shortSha)}.slice(0, 7);
    const openLabels = ${JSON.stringify(OPEN_LABELS)};
    const panel = document.querySelector('[data-testid="chat-panel"]');
    const cards = Array.from(
      (panel || document).querySelectorAll('div')
    ).filter((node) =>
      node.className && String(node.className).includes('rounded-xl') &&
      (node.innerText || '').includes(shaPrefix)
    );
    const card = cards[cards.length - 1] || null;
    const openButton = card
      ? Array.from(card.querySelectorAll('button')).find((button) =>
          openLabels.includes(button.getAttribute('aria-label') || '')
        )
      : null;
    if (!openButton) return { clicked: false };
    openButton.click();
    return { clicked: true };
  `);
}

async function diffPanelState() {
  const dom = await execJS(`
    return {
      bodyText: (document.body.innerText || '').slice(0, 20000),
      testIds: Array.from(document.querySelectorAll('[data-testid]'))
        .map((node) => node.getAttribute('data-testid'))
        .filter(Boolean)
        .slice(-80),
      hasReplayShell: !!document.querySelector('.session-replay-ide'),
      diffTabIds: Array.from(document.querySelectorAll('[data-testid]'))
        .map((node) => node.getAttribute('data-testid'))
        .filter((id) => id && id.includes('diff')),
    };
  `);
  const surface = await invokeE2E("inspectWorkstationSurface");
  return { ...dom, surface };
}

describe("Chat commit reference card → Diff commit detail", function () {
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

  it("opens an old commit from a non-git session via workspace-repo fallback", async function () {
    const { gitRepoPath, nonGitDirPath, shortSha } = fixtures;
    const sessionId = `e2e-commit-card-${RUN_ID}`;

    unwrap(
      await invokeE2E("navigateTo", "/orgii/workstation/code"),
      "navigateTo workstation code"
    );
    unwrap(await invokeE2E("resetToNewSession"), "resetToNewSession");

    // 1. Register the real git repo in the workspace repo store — this is
    //    the fallback pool the fix searches when the session context is
    //    not a git repository.
    unwrap(
      await invokeE2E("ensureRepoSelected", {
        repoPath: gitRepoPath,
        repoName: "commit-card-fixture-repo",
      }),
      "ensureRepoSelected"
    );

    // 2. Seed the bug shape: session events whose repo context is a plain
    //    non-git directory, with an assistant message referencing a commit
    //    that only exists in the registered fixture repo.
    const base = Date.now();
    unwrap(
      await invokeE2E("seedChatEvents", sessionId, [
        makeUserEvent(sessionId, nonGitDirPath, new Date(base).toISOString()),
        makeAssistantCommitEvent(
          sessionId,
          nonGitDirPath,
          shortSha,
          new Date(base + 1_000).toISOString()
        ),
      ]),
      "seedChatEvents"
    );

    // 3. Rendered presence: the assistant message text, then the commit
    //    reference card with its Open action.
    await browser.waitUntil(
      async () => (await commitCardState(shortSha)).bodyHasSha,
      {
        timeout: RENDER_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: `assistant message with sha never rendered: ${JSON.stringify(
          await commitCardState(shortSha)
        )}`,
      }
    );
    await browser.waitUntil(
      async () => {
        const state = await commitCardState(shortSha);
        return state.hasCard && state.hasOpenButton;
      },
      {
        timeout: RENDER_TIMEOUT_MS,
        interval: 250,
        timeoutMsg: `commit card never rendered: ${JSON.stringify(
          await commitCardState(shortSha)
        )}`,
      }
    );

    // 4. User action: click the card's Open button.
    const click = await clickCommitCardOpen(shortSha);
    if (!click?.clicked) {
      throw new Error("commit card Open button could not be clicked");
    }

    // 5. Observable result: the Diff app resolves the commit against the
    //    fixture repo and renders the commit detail — committed file name
    //    visible, and the error placeholder absent.
    await browser.waitUntil(
      async () => {
        const state = await diffPanelState();
        return state.bodyText.includes(SENTINEL_FILE);
      },
      {
        timeout: DIFF_DETAIL_TIMEOUT_MS,
        interval: 500,
        timeoutMsg: `commit detail (file ${SENTINEL_FILE}) never rendered; state=${JSON.stringify(
          await diffPanelState()
        )}`,
      }
    );

    const finalState = await diffPanelState();
    const failedText = FAILED_DIFF_TEXTS.find((text) =>
      finalState.bodyText.includes(text)
    );
    if (failedText) {
      throw new Error(
        `Diff panel still shows ${JSON.stringify(failedText)} after fallback resolution`
      );
    }
    if (!finalState.bodyText.includes(COMMIT_SUBJECT)) {
      throw new Error(
        `commit subject ${JSON.stringify(COMMIT_SUBJECT)} not visible in Diff panel`
      );
    }
  });
});
