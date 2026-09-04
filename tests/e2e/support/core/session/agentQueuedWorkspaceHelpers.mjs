import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  REPLY_TIMEOUT_MS,
  clickByTestId,
  execJS,
  invokeE2E,
  js,
  summarizeChatState,
  summarizePageDump,
} from "./agentQueuedFollowupDriver.mjs";

// Track every scenario tmpdir we create so the test suite can wipe them all
// on exit. macOS `/var/folders/.../T/` does not auto-clean, and we previously
// left thousands of `orgii-e2e-rewind-*` repos around between runs, which
// also caused background tasks (git watcher, worktree prune) to spam errors
// when the dirs were eventually GC'd while sessions still referenced them.
const SCENARIO_TMP_DIRS = new Set();
const E2E_MULTI_REPO_WORKSPACE = process.env.E2E_MULTI_REPO_WORKSPACE === "1";
let scenarioCleanupRegistered = false;

function registerScenarioCleanup() {
  if (scenarioCleanupRegistered) return;
  scenarioCleanupRegistered = true;
  const cleanup = () => {
    for (const dir of SCENARIO_TMP_DIRS) {
      try {
        fs.rmSync(dir, { force: true, recursive: true });
      } catch {
        // best-effort; the tmpdir may already be gone
      }
    }
    SCENARIO_TMP_DIRS.clear();
  };
  process.once("exit", cleanup);
  process.once("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
}

function initializeGitRepo(root, label) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, "README.md"),
    `# ORGII E2E Workspace\n\n${label}\n`,
    "utf8"
  );
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["add", "README.md"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], {
    cwd: root,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "ORGII E2E",
      GIT_AUTHOR_EMAIL: "e2e@orgii.local",
      GIT_COMMITTER_NAME: "ORGII E2E",
      GIT_COMMITTER_EMAIL: "e2e@orgii.local",
    },
  });
}

function createTempRepo(label) {
  registerScenarioCleanup();
  const safeLabel = label.replace(/[^a-zA-Z0-9]/g, "-");
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), `orgii-e2e-rewind-${safeLabel}-`)
  );
  SCENARIO_TMP_DIRS.add(root);

  if (!E2E_MULTI_REPO_WORKSPACE) {
    initializeGitRepo(root, label);
    return root;
  }

  const primaryRepo = path.join(root, "primary-repo");
  const siblingRepo = path.join(root, "sibling-repo");
  initializeGitRepo(primaryRepo, `${label} primary`);
  initializeGitRepo(siblingRepo, `${label} sibling`);
  fs.writeFileSync(
    path.join(siblingRepo, "README.md"),
    `# ORGII E2E Sibling Repo\n\n${label}\nSIBLING_ONLY_SENTINEL_${safeLabel}\n`,
    "utf8"
  );
  execFileSync("git", ["add", "README.md"], {
    cwd: siblingRepo,
    stdio: "ignore",
  });
  execFileSync("git", ["commit", "-m", "sibling sentinel"], {
    cwd: siblingRepo,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "ORGII E2E",
      GIT_AUTHOR_EMAIL: "e2e@orgii.local",
      GIT_COMMITTER_NAME: "ORGII E2E",
      GIT_COMMITTER_EMAIL: "e2e@orgii.local",
    },
  });
  return primaryRepo;
}

function listWorkspaceFiles(root) {
  const results = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolutePath = path.join(dir, entry.name);
      const relativePath = path.relative(root, absolutePath);
      if (
        relativePath === ".git" ||
        relativePath.startsWith(`${path.sep}.git${path.sep}`)
      ) {
        continue;
      }
      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      results.push(relativePath.split(path.sep).join("/"));
    }
  }
  walk(root);
  results.sort();
  return results;
}

function isPlanArtifactFile(file) {
  if (!file.endsWith(".md")) return false;
  if (file === "plan.md") return true;
  if (file === ".claude/plan.md") return true;
  if (file.startsWith(".orgii/plans/")) return true;
  if (file.startsWith(".orgii/cli-plans/")) return true;
  return false;
}

function throwIfProviderRuntimeBlocked(state, label) {
  const runtimeError = String(state?.runtimeError ?? "");
  const normalized = runtimeError.toLowerCase();
  if (
    normalized.includes("429") ||
    normalized.includes("too many requests") ||
    normalized.includes("quota_exhausted") ||
    normalized.includes("rate limited") ||
    normalized.includes("rate_limit") ||
    normalized.includes("capacity") ||
    normalized.includes("overloaded")
  ) {
    throw new Error(
      `${label} provider capacity blocked scenario: ${runtimeError}; state=${JSON.stringify(summarizeChatState(state))}`
    );
  }
}

function assertNoImplementationFilesCreated(label, beforeFiles, repoPath) {
  const before = new Set(beforeFiles);
  const after = listWorkspaceFiles(repoPath);
  const unexpectedFiles = after.filter((file) => {
    if (before.has(file)) return false;
    return !isPlanArtifactFile(file);
  });
  if (unexpectedFiles.length > 0) {
    throw new Error(
      `${label} Plan mode created implementation files before Build approval: ${JSON.stringify(unexpectedFiles)}`
    );
  }
}

// The file-changes panel was replaced by Agent Station Diff view in
// fbf20c78. Clicking the files pill now opens the diff view rather than
// expanding an inline panel. waitForFileChangesPanel clicks the pill and
// confirms the diff view opened (evidenced by the replay-tab-diff-filter
// tabs being mounted).
async function waitForFileChangesPanel(label) {
  // Wait for the files pill to appear first
  await browser.waitUntil(
    async () => {
      const state = await execJS(js.fileChanges);
      return state.filesPill;
    },
    {
      timeout: REPLY_TIMEOUT_MS,
      interval: 2_000,
      timeoutMsg: `${label} file changes pill never appeared; state=${JSON.stringify(await execJS(js.fileChanges))} chatState=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))} dump=${JSON.stringify(summarizePageDump(await execJS(js.pageDump)))}`,
    }
  );

  // If the Undo All button is already visible in the simulator header, we're
  // already in the diff view from a previous click — skip the pill click.
  const alreadyOpen = await execJS(js.fileChanges);
  if (alreadyOpen.undoAll) return;

  // Click the pill to open Agent Station Diff. Retry up to 3 times if the
  // diff view tabs don't appear — Tauri WebDriver clicks can miss on first
  // attempt when the pill is newly rendered.
  const MAX_EXPAND_ATTEMPTS = 3;
  const EXPAND_ATTEMPT_TIMEOUT_MS = 8_000;

  for (let attempt = 1; attempt <= MAX_EXPAND_ATTEMPTS; attempt++) {
    await clickByTestId(
      "composer-section-files",
      `${label} file changes pill (attempt ${attempt})`
    );

    // The pill now opens a dropdown menu (GitDiffActionsMenu); choose
    // "View in Agent station" to open the diff.
    await execJS(
      `const el = document.querySelector('[data-testid="git-diff-action-view-agent-station"]'); if (el) el.click(); return el ? "clicked" : "missing";`
    );

    const opened = await browser
      .waitUntil(
        async () => {
          // The diff view is open once its filter tabs are mounted. The Undo
          // All button (file-changes-undo-all) is rendered in
          // SimulatorWorkstationTabHeader whenever pendingCount > 0.
          const state = await execJS(js.fileChanges);
          if (state.undoAll) return true;
          const hasDiffTabs = await execJS(
            `return !!document.querySelector('[data-testid="replay-tab-diff-filter"]');`
          );
          return !!hasDiffTabs;
        },
        {
          timeout: EXPAND_ATTEMPT_TIMEOUT_MS,
          interval: 1_000,
        }
      )
      .catch(() => null);

    if (opened) return;
  }

  // Pill click did not open the diff view after all retries. Fall back to the
  // __e2e.openAgentStationDiff() bridge which sets the same atoms as the
  // product onClick handler — this ensures the Undo All button is rendered
  // even when Tauri WebDriver's element.click() misses React's synthetic
  // event dispatch for this pill.
  await invokeE2E("openAgentStationDiff");
  await browser.waitUntil(
    async () => {
      const state = await execJS(js.fileChanges);
      if (state.undoAll) return true;
      const hasDiffTabs = await execJS(
        `return !!document.querySelector('[data-testid="replay-tab-diff-filter"]');`
      );
      return !!hasDiffTabs;
    },
    {
      timeout: 10_000,
      interval: 500,
      timeoutMsg: async () => {
        const finalState = await execJS(js.fileChanges);
        const chatState = await invokeE2E("inspectChatState");
        return `${label} file changes panel did not open after pill retries + __e2e.openAgentStationDiff() fallback; state=${JSON.stringify(finalState)} chatState=${JSON.stringify(summarizeChatState(chatState))}`;
      },
    }
  );
}

async function waitForUndoAllEnabled(label) {
  // The Undo All button (data-testid="file-changes-undo-all") is only rendered
  // in SimulatorWorkstationTabHeader when pendingCount > 0, so its presence
  // implies it is enabled.
  await browser.waitUntil(
    async () => {
      const state = await execJS(js.fileChanges);
      return state.undoAll && !state.undoAllDisabled;
    },
    {
      timeout: 30_000,
      interval: 500,
      timeoutMsg: `${label} Undo All did not become enabled; state=${JSON.stringify(await execJS(js.fileChanges))} chatState=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))}`,
    }
  );
}

async function clickUndoAllAndConfirm(label) {
  await waitForUndoAllEnabled(label);
  await execJS(`window.__orgiiE2EAutoConfirmDestructive = true; return true;`);
  await clickByTestId("file-changes-undo-all", `${label} Undo All`);
}

async function waitForRedoAllEnabled(label) {
  await browser.waitUntil(
    async () => {
      const state = await execJS(js.fileChanges);
      return state.redoAll && !state.redoAllDisabled;
    },
    {
      timeout: 30_000,
      interval: 500,
      timeoutMsg: `${label} Redo All did not become enabled; state=${JSON.stringify(await execJS(js.fileChanges))} chatState=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))}`,
    }
  );
}

async function clickRedoAllAndConfirm(label) {
  await waitForRedoAllEnabled(label);
  await execJS(`window.__orgiiE2EAutoConfirmDestructive = true; return true;`);
  await clickByTestId("file-changes-redo-all", `${label} Redo All`);
}

function rewindPromptForConfig(_config, markerFile, markerText) {
  return [
    `Create a new markdown note named ${markerFile} in the current workspace.`,
    `The note must contain exactly this single line: ${markerText}`,
    "Please make the workspace change directly instead of only describing it.",
    "Do not use Shell or terminal commands.",
    "After the file is written, reply with exactly REWIND_FILE_CREATED and no other words.",
  ].join(" ");
}

async function waitForMarkerFile(
  config,
  filePath,
  markerText,
  timeoutMs = REPLY_TIMEOUT_MS
) {
  await browser.waitUntil(
    async () => {
      const chatState = await invokeE2E("inspectChatState");
      throwIfProviderRuntimeBlocked(chatState, config.label);
      return (
        fs.existsSync(filePath) &&
        fs.readFileSync(filePath, "utf8").includes(markerText)
      );
    },
    {
      timeout: timeoutMs,
      interval: 2_000,
      timeoutMsg: `${config.label} marker file was not created at ${filePath}; assistantTexts=${JSON.stringify(await execJS(js.assistantTexts))} fileChanges=${JSON.stringify(await execJS(js.fileChanges))} chatState=${JSON.stringify(summarizeChatState(await invokeE2E("inspectChatState")))}`,
    }
  );
}

function cleanupTempRepo(root) {
  if (!root) return;
  try {
    fs.rmSync(root, { force: true, recursive: true });
  } catch {
    // best-effort
  }
  SCENARIO_TMP_DIRS.delete(root);
}

export {
  assertNoImplementationFilesCreated,
  cleanupTempRepo,
  clickRedoAllAndConfirm,
  clickUndoAllAndConfirm,
  createTempRepo,
  listWorkspaceFiles,
  rewindPromptForConfig,
  waitForFileChangesPanel,
  waitForMarkerFile,
};
