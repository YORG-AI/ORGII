/* global describe, before, after, it, browser */
/**
 * diff-tab-content-live.spec.mjs
 *
 * LIVE-LLM coverage for the orgtrack final-diff → Diff-tab content render
 * path. The seeded spec (diff-tab-content-render.spec.mjs) proves
 * `finalDiffToSection` parses a `diff`-only record into a non-blank panel,
 * but it writes the backend record via the debug wire. This spec closes the
 * integration gap: a REAL agent turn edits a file in the repo, the orgtrack
 * extraction/backfill worker consolidates the change into a real
 * SessionFinalDiffRecord, and the Diff app must render the agent's actual
 * edited content (sentinel line) — no debug-seed anywhere.
 *
 * Per feedback_live_test_auto_behaviors: backend-authoritative data paths
 * (here: the orgtrack consolidation worker that feeds the Diff tab) need a
 * real-provider live spec, not just unit tests + seeded fixtures.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { hasAuthoritativeRunningTurn } from "../../support/core/session/agentQueuedControlScenarios.mjs";
import {
  configureScenario,
  execJS,
  filteredConfigs,
  invokeE2E,
  listAccounts,
  rustAgentConfigs,
  scenarioConfigs,
  stopActiveTurnIfNeeded,
  typeAndClickSend,
  unwrap,
  waitForApp,
  waitForChatLaunched,
} from "../../support/core/session/agentQueuedFollowupDriver.mjs";

const RUN_ID = Date.now();
const CHAT_INPUT = '[data-testid="chat-input"] [contenteditable="true"]';
const LIVE_TIMEOUT_MS = 300_000;
const DIFF_RENDER_TIMEOUT_MS = 120_000;

// Unique sentinel the agent must write; asserted in the rendered diff panel.
const SENTINEL = `DIFF_LIVE_SENTINEL_${RUN_ID}`;
const TARGET_FILE = `diff-live-${RUN_ID}.ts`;
// A single rendered code row taller than this means a line stretched the
// layout instead of scrolling — the "giant row" artifact regressed.
const MAX_SANE_LINE_HEIGHT_PX = 80;

function execFileWithClosedStdin(file, args, options) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
    child.stdin?.end();
  });
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function finalDiffCountForSession(orgiiHome, sessionId) {
  const databasePath = join(orgiiHome, "sessions.db");
  if (!existsSync(databasePath)) return 0;
  const sql = `
    SELECT COUNT(*)
    FROM orgtrack_core_final_diffs
    WHERE source = 'orgii_rust_agents'
      AND session_id = ${sqlLiteral(sessionId)};
  `;
  const { stdout } = await execFileWithClosedStdin(
    "sqlite3",
    [databasePath, sql],
    { maxBuffer: 1024 * 1024 }
  );
  return Number(stdout.trim() || "0");
}

async function diffPanelSnapshot() {
  return execJS(`
    const replay = document.querySelector('.session-replay-diff');
    if (!replay) {
      return {
        hasReplayShell: false,
        replayText: '',
        bodyTail: (document.body.innerText || '').slice(-1500),
      };
    }
    const editors = replay.querySelectorAll('.cm-editor');
    let maxLineHeight = 0;
    let maxLineSample = '';
    for (const line of replay.querySelectorAll('.cm-line')) {
      const h = line.getBoundingClientRect().height;
      if (h > maxLineHeight) {
        maxLineHeight = h;
        maxLineSample = (line.innerText || '').slice(0, 60);
      }
    }
    const sectionButtons = Array.from(replay.querySelectorAll('button'))
      .filter((b) => (b.innerText || '').includes(${JSON.stringify(TARGET_FILE)}));
    return {
      hasReplayShell: true,
      editorCount: editors.length,
      sectionButtonCount: sectionButtons.length,
      maxLineHeight: Math.round(maxLineHeight),
      maxLineSample,
      replayText: replay.innerText || '',
      bodyTail: (document.body.innerText || '').slice(-1500),
    };
  `);
}

// Click the file-section header toggle (chevron button labeled with the
// file name) so we can prove the section is collapsible.
async function toggleLiveFileSection() {
  return execJS(`
    const replay = document.querySelector('.session-replay-diff') || document;
    const btn = Array.from(replay.querySelectorAll('button'))
      .find((b) => (b.innerText || '').includes(${JSON.stringify(TARGET_FILE)}));
    if (!btn) return { clicked: false };
    btn.click();
    return { clicked: true };
  `);
}

describe("Diff tab content live (real agent edit → orgtrack final-diff)", () => {
  let config = null;
  let repoPath = null;
  let orgiiHome = null;
  let nativeSessionId = null;

  before(async function () {
    await waitForApp();
    const accounts = await listAccounts();
    const rustConfigs = rustAgentConfigs(
      filteredConfigs(scenarioConfigs(accounts))
    );
    if (rustConfigs.length === 0) {
      this.skip();
      return;
    }
    config =
      rustConfigs.find((row) => row.label === "claude-code-rust-agent") ??
      rustConfigs[0];
    repoPath = process.env.E2E_REPO_PATH;
    if (!repoPath) throw new Error("E2E_REPO_PATH missing");
    orgiiHome = process.env.ORGII_HOME;
    if (!orgiiHome) throw new Error("ORGII_HOME missing for isolated E2E run");
  });

  after(async () => {
    await stopActiveTurnIfNeeded("diff-tab-content-live-cleanup");
  });

  it("renders the agent's real edited content in the Diff tab", async function () {
    unwrap(
      await invokeE2E("ensureRepoSelected", { repoPath }),
      "ensureRepoSelected(diff provenance live)"
    );
    await configureScenario(config, { agentExecMode: "build" });

    const prompt = [
      `Create a new file named ${TARGET_FILE} in the repository root`,
      `(${repoPath}). The file must contain exactly this single line of`,
      `TypeScript: export const marker = "${SENTINEL}";`,
      `Use your edit_file / file-write tool to create it. Then use your`,
      `read-file tool to read the new file back and stop.`,
    ].join(" ");

    await typeAndClickSend(CHAT_INPUT, prompt);
    await waitForChatLaunched(prompt);

    // 1. Backend truth: the real agent turn wrote the file to disk. Only a
    //    live tool call could produce it (no seed path touches the fs).
    await browser.waitUntil(
      async () => existsSync(join(repoPath, TARGET_FILE)),
      {
        timeout: LIVE_TIMEOUT_MS,
        interval: 2_000,
        timeoutMsg: async () =>
          `agent never created ${TARGET_FILE}; tail=${JSON.stringify(
            (await diffPanelSnapshot()).bodyTail
          )}`,
      }
    );

    // File creation can precede turn finalization. Wait for both the
    // authoritative turn state and the production final-diff row before
    // mounting Diff; its initial load is intentionally not a poller.
    await browser.waitUntil(
      async () => {
        const state = unwrap(
          await invokeE2E("inspectChatState"),
          "inspectChatState(native provenance pre-Diff)"
        );
        nativeSessionId = state.activeSessionId;
        return Boolean(nativeSessionId) && !hasAuthoritativeRunningTurn(state);
      },
      {
        timeout: LIVE_TIMEOUT_MS,
        interval: 2_000,
        timeoutMsg: "native ORG2 turn never settled after writing and reading",
      }
    );
    await browser.waitUntil(
      async () =>
        (await finalDiffCountForSession(orgiiHome, nativeSessionId)) > 0,
      {
        timeout: DIFF_RENDER_TIMEOUT_MS,
        interval: 1_000,
        timeoutMsg: "native ORG2 final diff never became authoritative",
      }
    );

    // 2. Open the Diff app (same atoms as the product "View in Agent
    //    station" / files-pill click path).
    await browser.waitUntil(
      async () => (await invokeE2E("openAgentStationDiff")).ok === true,
      {
        timeout: 30_000,
        interval: 1_000,
        timeoutMsg: "openAgentStationDiff never succeeded",
      }
    );

    await browser.waitUntil(
      async () => (await diffPanelSnapshot()).hasReplayShell,
      {
        timeout: 30_000,
        interval: 500,
        timeoutMsg: "Diff replay shell never mounted",
      }
    );

    // 3. The Diff tab must render the agent's REAL edited content. This is
    //    the orgtrack final-diff path: the extraction/backfill worker
    //    consolidated the live edit into a SessionFinalDiffRecord, and
    //    finalDiffToSection rendered it. Before the fix a diff-only record
    //    produced a blank panel; here the sentinel must be visible.
    let snap = null;
    await browser.waitUntil(
      async () => {
        snap = await diffPanelSnapshot();
        return snap.replayText.includes(SENTINEL) && snap.editorCount > 0;
      },
      {
        timeout: DIFF_RENDER_TIMEOUT_MS,
        interval: 2_000,
        timeoutMsg: async () =>
          `live diff content never rendered the sentinel; snapshot=${JSON.stringify(
            await diffPanelSnapshot()
          )}`,
      }
    );

    // 3a. Structural health on the LIVE render: no single code row may be
    //     absurdly tall (the "giant row" artifact). The live path does not
    //     guarantee a collapse band (depends on file size), so we only
    //     assert the universal invariants here; the collapse-band + expand
    //     coverage lives in the seeded spec which controls the diff shape.
    expect(snap.maxLineHeight).toBeLessThan(MAX_SANE_LINE_HEIGHT_PX);

    // 3b. The file section is collapsible: clicking its header toggle hides
    //     the editor, clicking again restores it — the same collapsible
    //     chevron the user operates.
    expect(snap.sectionButtonCount).toBeGreaterThan(0);
    unwrap(
      (await toggleLiveFileSection()).clicked
        ? { ok: true }
        : { ok: false, error: "file section toggle not found" },
      "toggleLiveFileSection(collapse)"
    );
    await browser.waitUntil(
      async () => (await diffPanelSnapshot()).editorCount === 0,
      {
        timeout: 10_000,
        interval: 400,
        timeoutMsg: "live file section never collapsed (editor still mounted)",
      }
    );
    unwrap(
      (await toggleLiveFileSection()).clicked
        ? { ok: true }
        : { ok: false, error: "file section toggle not found" },
      "toggleLiveFileSection(expand)"
    );
    await browser.waitUntil(
      async () => (await diffPanelSnapshot()).editorCount > 0,
      {
        timeout: 10_000,
        interval: 400,
        timeoutMsg: "live file section never re-expanded",
      }
    );

    expect(nativeSessionId).toBeTruthy();
  });
});
