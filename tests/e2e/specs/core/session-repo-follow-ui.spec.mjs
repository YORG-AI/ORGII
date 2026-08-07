/**
 * session-repo-follow-ui.spec.mjs
 *
 * "My Station follows the active session's repo" (jumpToSessionAtom →
 * followSessionRepo, commit cc60bad7).
 *
 * Rendered, no-LLM coverage:
 *  - Two spec-created git repos (X, Y) under $HOME are registered via
 *    `ensureRepoSelected`.
 *  - Three sidebar session rows are seeded via `seedSidebarSession`:
 *      A → repoPath X, B → repoPath Y, C → unregistered path.
 *  - The spec performs REAL clicks on the rendered sidebar rows (the same
 *    `handleMenuItemClick` → `openSession` → `jumpToSessionAtom` path a
 *    user exercises) and asserts the rendered status-bar repo indicator
 *    (`status-bar-repo-name`) follows the session's workspace.
 *  - Negative (Rule 9): clicking C (unregistered repoPath) must NOT move
 *    the repo indicator, and no "Switch to" hint appears (the hint only
 *    exists for registered repos, which now auto-follow instead).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MOUNT_TIMEOUT_MS = 60_000;
const RENDER_TIMEOUT_MS = 15_000;
const RUN_ID = Date.now();

// Fixtures live under $HOME (NOT /tmp): the WorkStation shell checks the
// selected repo path with the Tauri fs plugin (`exists()`), whose scope
// covers $HOME but not /tmp. A /tmp repo path makes the Code Editor render
// the "Cannot find <repo>" placeholder, and the status-bar repo indicator
// (which syncs from the mounted shell) never settles.
const FIXTURE_ROOT = join(homedir(), `.orgii-e2e-repofollow-${RUN_ID}`);
const REPO_X_PATH = join(FIXTURE_ROOT, "repo-x");
const REPO_Y_PATH = join(FIXTURE_ROOT, "repo-y");
const LINKED_WORKTREE_PATH = join(FIXTURE_ROOT, "repo-x-linked-worktree");
const LINKED_WORKTREE_BRANCH = `e2e-linked-${RUN_ID}`;
const UNREGISTERED_PATH = join(FIXTURE_ROOT, "unregistered");

const REPO_X_NAME = `E2E Follow Repo X ${RUN_ID}`;
const REPO_Y_NAME = `E2E Follow Repo Y ${RUN_ID}`;

const SESSION_A = `sdeagent-e2e-repofollow-a-${RUN_ID}`;
const SESSION_B = `sdeagent-e2e-repofollow-b-${RUN_ID}`;
const SESSION_C = `sdeagent-e2e-repofollow-c-${RUN_ID}`;
const WARMUP_SESSION = `sdeagent-e2e-repofollow-warmup-${RUN_ID}`;

function createGitFixture(repoPath, readmeTitle) {
  rmSync(repoPath, { force: true, recursive: true });
  mkdirSync(repoPath, { recursive: true });
  writeFileSync(join(repoPath, "README.md"), `# ${readmeTitle}\n`);
  execFileSync("git", ["init", "--initial-branch=main", repoPath], {
    stdio: "ignore",
  });
  execFileSync("git", ["-C", repoPath, "add", "README.md"], {
    stdio: "ignore",
  });
  execFileSync(
    "git",
    [
      "-C",
      repoPath,
      "-c",
      "user.name=ORGII E2E",
      "-c",
      "user.email=e2e@orgii.local",
      "commit",
      "-m",
      "Initial repo-follow fixture",
    ],
    { stdio: "ignore" }
  );
}

function createLinkedWorktree() {
  rmSync(LINKED_WORKTREE_PATH, { force: true, recursive: true });
  execFileSync(
    "git",
    [
      "-C",
      REPO_X_PATH,
      "worktree",
      "add",
      "-b",
      LINKED_WORKTREE_BRANCH,
      LINKED_WORKTREE_PATH,
      "main",
    ],
    { stdio: "ignore" }
  );
}

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

async function waitForFrontendReady() {
  const port = process.env.E2E_FRONTEND_PORT ?? "1998";
  const url = `http://127.0.0.1:${port}`;
  await browser.waitUntil(
    async () => {
      try {
        const response = await fetch(url, { method: "GET" });
        return response.ok;
      } catch {
        return false;
      }
    },
    {
      timeout: MOUNT_TIMEOUT_MS,
      timeoutMsg: `frontend dev server never became ready at ${url}`,
    }
  );
}

async function waitForApp() {
  await waitForFrontendReady();
  await browser.setTimeout({ script: 10_000 });
  await execJS(`localStorage.setItem('orgii:auth_skipped', '1'); return true;`);
  await browser.waitUntil(
    async () => {
      try {
        return await execJS(
          `return document.readyState === 'complete' || document.readyState === 'interactive';`
        );
      } catch {
        return false;
      }
    },
    {
      timeout: MOUNT_TIMEOUT_MS,
      timeoutMsg: "app document never became script-readable",
    }
  );
  await browser.waitUntil(
    async () => {
      try {
        return await execJS(
          `return !!(window.__e2e && window.__e2e.ensureRepoSelected && window.__e2e.seedSidebarSession && window.__e2e.navigateTo);`
        );
      } catch {
        return false;
      }
    },
    {
      timeout: MOUNT_TIMEOUT_MS,
      timeoutMsg:
        "window.__e2e repo-follow helpers (ensureRepoSelected/seedSidebarSession/navigateTo) never exposed",
    }
  );
}

async function statusBarRepoLabel() {
  return execJS(`
    const el = document.querySelector('[data-testid="status-bar-repo-name"]');
    return el ? (el.textContent || "").trim() : null;
  `);
}

async function clickRendered(selector, label) {
  const element = await $(selector);
  await element.waitForDisplayed({
    timeout: RENDER_TIMEOUT_MS,
    timeoutMsg: `${label} never rendered`,
  });
  await element.click();
}

async function spotlightSnapshot() {
  return execJS(`
    const rows = Array.from(document.querySelectorAll('[data-spotlight-item-id]'));
    return {
      input: document.querySelector('[data-spotlight-input="true"]')?.getAttribute('placeholder') ?? null,
      rows: rows.map((row) => ({
        id: row.getAttribute('data-spotlight-item-id'),
        text: (row.textContent || '').trim(),
        current: row.classList.contains('is-current-selection'),
      })),
      bodySample: (document.body.innerText || '').slice(0, 1400),
    };
  `);
}

async function waitForSpotlightItem(itemId, label) {
  try {
    await browser.waitUntil(
      async () =>
        execJS(
          `return !!document.querySelector('[data-spotlight-item-id="${itemId}"]');`
        ),
      {
        timeout: RENDER_TIMEOUT_MS,
        timeoutMsg: `${label} did not render in Spotlight`,
      }
    );
  } catch (error) {
    throw new Error(
      `${error.message}: ${JSON.stringify(await spotlightSnapshot())}`
    );
  }
}

async function statusBarSnapshot() {
  return execJS(`
    const repoEl = document.querySelector('[data-testid="status-bar-repo-name"]');
    const hintEl = document.querySelector('[data-testid="status-bar-switch-to-session-repo"]');
    return {
      repoLabel: repoEl ? (repoEl.textContent || "").trim() : null,
      hintLabel: hintEl ? (hintEl.textContent || "").trim() : null,
      location: window.location.pathname,
      bodySample: (document.body.innerText || "").slice(0, 800),
    };
  `);
}

async function waitForStatusBarRepo(expectedName, context) {
  try {
    await browser.waitUntil(
      async () => {
        const label = await statusBarRepoLabel();
        return typeof label === "string" && label.includes(expectedName);
      },
      {
        timeout: RENDER_TIMEOUT_MS,
        timeoutMsg: `status bar repo indicator did not show "${expectedName}" (${context})`,
      }
    );
  } catch (error) {
    throw new Error(
      `${error.message}: ${JSON.stringify(await statusBarSnapshot())}`
    );
  }
}

async function clickSidebarSessionRow(sessionId) {
  await browser.waitUntil(
    async () =>
      execJS(
        `return !!document.querySelector('[data-testid="sidebar-session-item-${sessionId}"]');`
      ),
    {
      timeout: RENDER_TIMEOUT_MS,
      timeoutMsg: `sidebar session row ${sessionId} never rendered`,
    }
  );

  // The sidebar re-renders while its initial forceRefresh load settles; a
  // click dispatched onto a just-detached row node is silently dropped.
  // Retry the rendered click until the session actually activates.
  const maxAttempts = 6;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const clickResult = await execJS(`
      const row = document.querySelector('[data-testid="sidebar-session-item-${sessionId}"]');
      if (!row) return "missing";
      row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window, button: 0 }));
      row.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window, button: 0 }));
      row.click();
      return "clicked";
    `);
    if (clickResult !== "clicked") {
      await browser.pause(500);
      continue;
    }
    try {
      await browser.waitUntil(
        async () => {
          const active = await invokeE2E("getActiveSessionId");
          return active?.ok === true && active.sessionId === sessionId;
        },
        { timeout: 3_000 }
      );
      return;
    } catch {
      // Session did not activate — the click was likely swallowed by a
      // re-render. Loop and click the (fresh) row node again.
    }
  }
  const active = await invokeE2E("getActiveSessionId");
  throw new Error(
    `sidebar session row ${sessionId} click never activated the session after ${maxAttempts} attempts; active=${JSON.stringify(active)}`
  );
}

describe("My Station follows the active session's repo", () => {
  before(async () => {
    createGitFixture(REPO_X_PATH, "E2E repo-follow repo X");
    createLinkedWorktree();
    createGitFixture(REPO_Y_PATH, "E2E repo-follow repo Y");
    await waitForApp();

    // Register repo Y first, then repo X — pinning X last leaves X as the
    // selected single-root workspace while BOTH stay in the registered
    // repos list (`reposAtom`), which is what followSessionRepo matches on.
    //
    // The app's own startup repo loader (`useRepoLoader.loadRepos`) REPLACES
    // `reposAtom` with backend rows when its async fetch resolves; if it
    // lands after our pin, the fixture repos are wiped and the status bar
    // goes blank. Stabilize by re-pinning until the rendered status bar
    // actually shows repo X.
    const pinFixtureRepos = async () => {
      unwrap(
        await invokeE2E("ensureRepoSelected", {
          repoPath: REPO_Y_PATH,
          repoName: REPO_Y_NAME,
        }),
        "ensureRepoSelected(repo Y)"
      );
      unwrap(
        await invokeE2E("ensureRepoSelected", {
          repoPath: REPO_X_PATH,
          repoName: REPO_X_NAME,
        }),
        "ensureRepoSelected(repo X)"
      );
    };
    await pinFixtureRepos();

    // Warmup seed: forces my-station mode + a NON-maximized chat panel so
    // the WorkStation status bar is actually visible. (chatPanelMaximized
    // persists in localStorage, so a previous run could otherwise leave the
    // chat overlay covering the status bar.)
    unwrap(
      await invokeE2E(
        "seedChatEvents",
        WARMUP_SESSION,
        [
          {
            id: "repofollow-warmup-user",
            chunk_id: "repofollow-warmup-user",
            sessionId: WARMUP_SESSION,
            createdAt: new Date().toISOString(),
            functionName: "user_message",
            uiCanonical: "user_message",
            actionType: "raw",
            args: {},
            result: { type: "user", message: "warmup", is_delta: false },
            source: "user",
            displayText: "warmup",
            displayStatus: "completed",
            displayVariant: "message",
            activityStatus: "processed",
            isDelta: false,
          },
        ],
        { chatPanelMaximized: false, stationMode: "my-station" }
      ),
      "seedChatEvents(warmup)"
    );

    // Seed the three sidebar rows the user will click.
    unwrap(
      await invokeE2E("seedSidebarSession", {
        sessionId: SESSION_A,
        name: `E2E repo-follow A ${RUN_ID}`,
        repoPath: REPO_X_PATH,
      }),
      "seedSidebarSession(A)"
    );
    unwrap(
      await invokeE2E("seedSidebarSession", {
        sessionId: SESSION_B,
        name: `E2E repo-follow B ${RUN_ID}`,
        repoPath: REPO_Y_PATH,
      }),
      "seedSidebarSession(B)"
    );
    unwrap(
      await invokeE2E("seedSidebarSession", {
        sessionId: SESSION_C,
        name: `E2E repo-follow C ${RUN_ID}`,
        repoPath: UNREGISTERED_PATH,
      }),
      "seedSidebarSession(C)"
    );

    unwrap(
      await invokeE2E("navigateTo", "/orgii/workstation/code"),
      "navigateTo(workstation code)"
    );

    // Baseline: repo X (pinned last) is the selected workspace. The startup
    // repo loader can asynchronously clobber the pinned fixture repos, so
    // keep re-pinning until the rendered status bar stabilizes on repo X.
    try {
      await browser.waitUntil(
        async () => {
          const label = await statusBarRepoLabel();
          if (typeof label === "string" && label.includes(REPO_X_NAME)) {
            return true;
          }
          await pinFixtureRepos();
          return false;
        },
        {
          timeout: 30_000,
          interval: 1_000,
          timeoutMsg:
            "status bar repo indicator never stabilized on repo X at baseline",
        }
      );
    } catch (error) {
      throw new Error(
        `${error.message}: ${JSON.stringify(await statusBarSnapshot())}`
      );
    }
  });

  after(() => {
    try {
      execFileSync(
        "git",
        [
          "-C",
          REPO_X_PATH,
          "worktree",
          "remove",
          "--force",
          LINKED_WORKTREE_PATH,
        ],
        { stdio: "ignore" }
      );
    } catch {
      // The fixture root cleanup below is authoritative.
    }
    rmSync(FIXTURE_ROOT, { force: true, recursive: true });
  });

  it("opens the Worktree picker from the rendered status bar and switches the active worktree", async () => {
    // Return to repo X so its linked worktree is the active selector context.
    await clickSidebarSessionRow(SESSION_A);
    await waitForStatusBarRepo(REPO_X_NAME, "before opening Worktree picker");

    const gitControlOrder = await execJS(`
      const repo = document.querySelector('[data-testid="status-bar-repo-name"]');
      const worktree = document.querySelector('[data-testid="status-bar-worktree"]');
      const branch = document.querySelector('[data-testid="status-bar-branch"]');
      const follows = (left, right) =>
        !!left && !!right &&
        !!(left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING);
      return {
        repoBeforeWorktree: follows(repo, worktree),
        worktreeBeforeBranch: follows(worktree, branch),
      };
    `);
    if (
      !gitControlOrder.repoBeforeWorktree ||
      !gitControlOrder.worktreeBeforeBranch
    ) {
      throw new Error(
        `status bar git controls are not Workspace → Worktree → Branch: ${JSON.stringify(gitControlOrder)}`
      );
    }

    // Exercise the production status-bar click -> openWorktreeSpotlight ->
    // GlobalSpotlight WorktreePalette path. The fixture helper only seeded the
    // durable repo/worktree precondition; it does not open or select the UI.
    await clickRendered(
      '[data-testid="status-bar-worktree"]',
      "status bar Worktree button"
    );

    const linkedItemId = `worktree:${LINKED_WORKTREE_PATH}`;
    const mainItemId = `worktree:${REPO_X_PATH}`;
    await waitForSpotlightItem(mainItemId, "main worktree row");
    await waitForSpotlightItem(linkedItemId, "linked worktree row");
    await waitForSpotlightItem("worktree:new", "New Worktree action");

    const initial = await spotlightSnapshot();
    const linkedRow = initial.rows.find((row) => row.id === linkedItemId);
    if (
      !linkedRow ||
      !linkedRow.text.includes("repo-x-linked-worktree") ||
      !linkedRow.text.includes(LINKED_WORKTREE_BRANCH)
    ) {
      throw new Error(
        `linked Worktree row did not show path and branch: ${JSON.stringify(initial)}`
      );
    }

    await clickRendered(
      `[data-spotlight-item-id="${linkedItemId}"]`,
      "linked Worktree row"
    );
    await browser.waitUntil(
      async () => {
        const snapshot = await execJS(`
          const worktree = document.querySelector('[data-testid="status-bar-worktree"]');
          const branch = document.querySelector('[data-testid="status-bar-branch"]');
          return {
            worktree: worktree ? (worktree.textContent || '').trim() : null,
            branch: branch ? (branch.textContent || '').trim() : null,
            spotlightOpen: !!document.querySelector('[data-spotlight-input="true"]'),
          };
        `);
        return (
          snapshot.worktree?.includes("repo-x-linked-worktree") &&
          snapshot.branch?.includes(LINKED_WORKTREE_BRANCH) &&
          snapshot.spotlightOpen === false
        );
      },
      {
        timeout: RENDER_TIMEOUT_MS,
        timeoutMsg:
          "rendered status bar did not update after selecting the linked Worktree",
      }
    );

    // Reopen through the real rendered button to prove the new current row and
    // the New Worktree action remain available after a production selection.
    await clickRendered(
      '[data-testid="status-bar-worktree"]',
      "updated status bar Worktree button"
    );
    await waitForSpotlightItem(linkedItemId, "selected linked worktree row");
    const selected = await spotlightSnapshot();
    const selectedRow = selected.rows.find((row) => row.id === linkedItemId);
    if (!selectedRow?.current) {
      throw new Error(
        `selected Worktree row was not marked current: ${JSON.stringify(selected)}`
      );
    }

    await clickRendered(
      '[data-spotlight-item-id="worktree:new"]',
      "New Worktree action"
    );
    await browser.waitUntil(
      async () =>
        execJS(
          `return !!document.getElementById('worktree-source-smart-input');`
        ),
      {
        timeout: RENDER_TIMEOUT_MS,
        timeoutMsg:
          "New Worktree action did not open the rendered worktree source modal",
      }
    );

    await browser.keys(["Escape"]);
    await browser.waitUntil(
      async () =>
        execJS(
          `return !document.getElementById('worktree-source-smart-input');`
        ),
      {
        timeout: RENDER_TIMEOUT_MS,
        timeoutMsg: "Escape did not close the rendered worktree source modal",
      }
    );

    await browser.keys(["Escape"]);
    await browser.waitUntil(
      async () =>
        execJS(
          `return !document.querySelector('[data-spotlight-input="true"]');`
        ),
      {
        timeout: RENDER_TIMEOUT_MS,
        timeoutMsg: "Escape did not close the Worktree Spotlight",
      }
    );
  });

  it("switching to session B (repo Y) makes My Station show repo Y", async () => {
    await clickSidebarSessionRow(SESSION_B);
    await waitForStatusBarRepo(REPO_Y_NAME, "after clicking session B row");
  });

  it("switching to session A (repo X) makes My Station show repo X", async () => {
    await clickSidebarSessionRow(SESSION_A);
    await waitForStatusBarRepo(REPO_X_NAME, "after clicking session A row");
  });

  it("switching to session C (unregistered repoPath) leaves the repo selection unchanged", async () => {
    // Pre-condition from the previous test: repo X is selected.
    await clickSidebarSessionRow(SESSION_C);

    // The session DID switch (sidebar row C selected)…
    await browser.waitUntil(
      async () => {
        const active = await invokeE2E("getActiveSessionId");
        return active?.ok === true && active.sessionId === SESSION_C;
      },
      {
        timeout: RENDER_TIMEOUT_MS,
        timeoutMsg: "clicking session C did not activate the session",
      }
    );

    // …but the repo indicator must NOT move (degraded path: no registered
    // match → no auto-follow). Give any wrongly-triggered follow a moment
    // to land before asserting stability.
    await browser.pause(1_000);
    const snapshot = await statusBarSnapshot();
    if (!snapshot.repoLabel || !snapshot.repoLabel.includes(REPO_X_NAME)) {
      throw new Error(
        `repo indicator moved after clicking session with UNREGISTERED repoPath: ${JSON.stringify(snapshot)}`
      );
    }
    // No "Switch to" hint either — the hint atom only fires for registered
    // repos, and registered repos now auto-follow.
    if (snapshot.hintLabel) {
      throw new Error(
        `unexpected "Switch to" hint for unregistered session repo: ${JSON.stringify(snapshot)}`
      );
    }
  });
});
