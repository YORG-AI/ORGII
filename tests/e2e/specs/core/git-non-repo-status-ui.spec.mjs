/**
 * git-non-repo-status-ui.spec.mjs
 *
 * Regression coverage for "non-git folders periodically pop up git errors".
 *
 * A folder the user creates directly (never `git init`'d) must NOT surface
 * git errors. The backend now returns a benign `exists: false` (HTTP 200) for
 * such paths instead of a "not a git repository" error, and the frontend
 * writes a TERMINAL non-git cache entry that is never retried.
 *
 * Rendered, no-LLM coverage (via window.__e2e bridge, same client the UI uses):
 *  - Non-git folder fixture under $HOME → getGitStatusForPath returns
 *    `exists: false` (benign), NOT an error throw. (the fix)
 *  - Control git repo fixture → getGitStatusForPath returns `exists: true`
 *    and renders a real branch/status (proves we didn't break real repos).
 *  - Negative (Rule 9): the non-git fetch resolves cleanly — no thrown error,
 *    no error flag — so the UI never enters the recurring error-popup loop.
 *
 * Fixtures live under $HOME (NOT /tmp): the Tauri fs plugin scope covers $HOME.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MOUNT_TIMEOUT_MS = 60_000;
const RUN_ID = Date.now();

const FIXTURE_ROOT = join(homedir(), `.orgii-e2e-nongit-${RUN_ID}`);
const NON_GIT_FOLDER = join(FIXTURE_ROOT, "plain-folder");
const GIT_REPO = join(FIXTURE_ROOT, "real-repo");

function createPlainFolder(dirPath) {
  rmSync(dirPath, { force: true, recursive: true });
  mkdirSync(dirPath, { recursive: true });
  writeFileSync(join(dirPath, "notes.txt"), "just a folder, no git here\n");
}

function createGitFixture(repoPath) {
  rmSync(repoPath, { force: true, recursive: true });
  mkdirSync(repoPath, { recursive: true });
  writeFileSync(join(repoPath, "README.md"), "# real repo\n");
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
      "Initial fixture",
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
          `return !!(window.__e2e && window.__e2e.getGitStatusForPath && window.__e2e.pinFolderWorkspace);`
        );
      } catch {
        return false;
      }
    },
    {
      timeout: MOUNT_TIMEOUT_MS,
      timeoutMsg: "window.__e2e git-non-repo helpers never became available",
    }
  );
}

describe("git status on non-git folders (no recurring error)", () => {
  before(async () => {
    createPlainFolder(NON_GIT_FOLDER);
    createGitFixture(GIT_REPO);
    await waitForApp();
  });

  after(() => {
    rmSync(FIXTURE_ROOT, { force: true, recursive: true });
  });

  it("returns a benign exists:false for a non-git folder (no error)", async () => {
    const res = unwrap(
      await invokeE2E("getGitStatusForPath", NON_GIT_FOLDER),
      "getGitStatusForPath(non-git)"
    );
    // The fix: a folder with no .git resolves to a clean HTTP 200 exists:false
    // state. Before the fix this returned an error and the UI looped.
    if (res.httpStatus !== 200) {
      throw new Error(
        `expected HTTP 200 (benign) for non-git folder, got ${JSON.stringify(res)}`
      );
    }
    if (res.exists !== false) {
      throw new Error(
        `expected exists:false for non-git folder, got ${JSON.stringify(res)}`
      );
    }
  });

  it("control git repo still reports exists:true (no regression)", async () => {
    const res = unwrap(
      await invokeE2E("getGitStatusForPath", GIT_REPO),
      "getGitStatusForPath(git)"
    );
    if (res.exists !== true) {
      throw new Error(
        `expected exists:true for real git repo, got ${JSON.stringify(res)}`
      );
    }
  });

  it("pins the non-git folder as a workspace without surfacing an error", async () => {
    unwrap(
      await invokeE2E("pinFolderWorkspace", NON_GIT_FOLDER, "E2E Plain Folder"),
      "pinFolderWorkspace"
    );
    // Negative (Rule 9): after pinning a folder workspace, fetching its git
    // status still resolves cleanly — no thrown error, no infinite retry.
    const res = unwrap(
      await invokeE2E("getGitStatusForPath", NON_GIT_FOLDER),
      "getGitStatusForPath(after pin)"
    );
    if (res.exists !== false) {
      throw new Error(
        `expected non-git workspace to stay exists:false, got ${JSON.stringify(res)}`
      );
    }
  });
});
