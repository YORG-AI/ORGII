/**
 * diff-tab-content-render.spec.mjs
 *
 * Rendered-UI coverage for the orgtrack final-diff → Diff-tab content path:
 *
 * The orgtrack extraction scheduler stores `SessionFinalDiffRecord` entries
 * that may have only a `diff` unified-diff string (null old_content /
 * new_content). Before the fix, `finalDiffToSection` ignored `diff` and
 * only used `oldContent`/`newContent`, producing blank (empty) CodeMirrorDiff
 * panels. After the fix, `finalDiffToSection` parses `diff` as a fallback.
 *
 * This spec seeds a `diff`-only final-diff record via the debug-only
 * `debug_seed_final_diff` wire, opens the Diff app, clicks the Diff tab, and
 * asserts the content renders (sentinel lines visible, no blank/empty panel).
 *
 * Architecture: the Diff app's "diff" tab iterates `orgtrackFinalDiffs` from
 * `getOrgtrackSessionFinalDiffs` and maps each through `finalDiffToSection`
 * into a `DiffFileNavigationItem<DiffFileSectionData>` rendered by
 * `DiffSectionList` → `CodeMirrorDiff`.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MOUNT_TIMEOUT_MS = 60_000;
const RENDER_TIMEOUT_MS = 12_000;
const DIFF_DETAIL_TIMEOUT_MS = 30_000;
const RUN_ID = Date.now();

// Sentinel content injected into the seeded diff so the spec can assert
// the rendered panel contains expected text.
const SENTINEL_OLD = `const SENTINEL_${RUN_ID}_OLD = "before";`;
const SENTINEL_NEW = `const SENTINEL_${RUN_ID}_NEW = "after";`;
const SEEDED_FILE_PATH = "src/sentinel.ts";

// A line long enough to overflow the editor width. The "over-wide / giant
// row" artifact (workspace_session_replay_diff_consolidation_bug) stretched
// the whole section instead of scrolling horizontally; the SCSS fix
// (max-width:100% + overflow-x:auto) keeps every rendered line at a normal
// row height. We assert no .cm-line exceeds a sane height bound.
const LONG_LINE = `const SENTINEL_${RUN_ID}_LONG = "${"x".repeat(400)}";`;
// Any single rendered code row taller than this means the line wrapped /
// stretched the layout instead of scrolling — i.e. the bug regressed.
const MAX_SANE_LINE_HEIGHT_PX = 80;
// CodeMirror's collapseUnchanged uses {margin:3, minSize:10}; we need a run
// of >=10 identical context lines around the change so a collapse band
// ("N unchanged lines") is actually produced.
const CONTEXT_LINE_COUNT = 24;

async function execJS(script) {
  return browser.executeScript(script, []);
}

// Isolated E2E homes boot to the login page; set the BYOK soft-pass flag so
// AuthGuard/AuthRedirect treat the session as authorized. Done before any
// navigateTo so the Workstation route is reachable. We avoid location.reload()
// (it kills the tauri-wd WebDriver session) — navigateTo re-routes in place.
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
            window.__e2e.openAgentStationDiff &&
            window.__e2e.debugSeedFinalDiffWire);`
        );
      } catch {
        return false;
      }
    },
    {
      timeout: MOUNT_TIMEOUT_MS,
      timeoutMsg: "window.__e2e seed/diff helpers never exposed",
    }
  );
}

// ── Fixture: a real git repo for orgtrack session context ────────────────

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
  const root = mkdtempSync(join(tmpdir(), "orgii-e2e-diff-content-"));
  const gitRepoPath = join(root, "repo");
  mkdirSync(gitRepoPath, { recursive: true });

  execFileSync("git", ["init", "--initial-branch=main", gitRepoPath], {
    stdio: "ignore",
  });
  writeFileSync(join(gitRepoPath, "README.md"), "# diff-content fixture\n");
  git(gitRepoPath, ["add", "README.md"]);
  git(gitRepoPath, ["commit", "-m", "Initial"]);

  return { root, gitRepoPath };
}

// ── Event factories ──────────────────────────────────────────────────────

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
    displayText: "make a change",
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "processed",
    isDelta: false,
  };
}

// ── DOM probes ───────────────────────────────────────────────────────────

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

// Snapshot the rendered diff's structural health: the collapse band
// ("N unchanged lines"), the file-section toggle button, the CodeMirror
// editor presence, and the tallest rendered code row. This is the proof
// that the panel is the real collapsible/expandable diff — not a blank or
// a single absurdly-tall row.
async function diffStructureSnapshot() {
  return execJS(`
    const replay = document.querySelector('.session-replay-diff');
    if (!replay) return { hasReplayShell: false };

    // File-section toggle: the collapsible chevron <button> whose text is
    // the file name (DiffFileSection renders content only when expanded).
    const sectionButtons = Array.from(replay.querySelectorAll('button'))
      .filter((b) => (b.innerText || '').includes('sentinel.ts'));

    // CodeMirror editor(s) actually mounted (content is only present when
    // the section is expanded).
    const editors = Array.from(replay.querySelectorAll('.cm-editor'));

    // The native collapse band for unchanged regions.
    const collapseBands = Array.from(
      replay.querySelectorAll('.cm-collapsedLines')
    );

    // Tallest single rendered code row — guards the "giant row" artifact.
    let maxLineHeight = 0;
    let maxLineSample = '';
    for (const line of replay.querySelectorAll('.cm-line')) {
      const h = line.getBoundingClientRect().height;
      if (h > maxLineHeight) {
        maxLineHeight = h;
        maxLineSample = (line.innerText || '').slice(0, 60);
      }
    }

    // Does the editor scroll horizontally (the correct behavior for a long
    // line) rather than stretch the section? Compare scrollWidth vs client.
    let horizontallyScrollable = false;
    for (const sc of replay.querySelectorAll('.cm-scroller')) {
      if (sc.scrollWidth > sc.clientWidth + 4) horizontallyScrollable = true;
    }

    return {
      hasReplayShell: true,
      sectionButtonCount: sectionButtons.length,
      editorCount: editors.length,
      collapseBandCount: collapseBands.length,
      collapseBandText: collapseBands.map((b) => (b.innerText || '').trim()),
      maxLineHeight: Math.round(maxLineHeight),
      maxLineSample,
      horizontallyScrollable,
      replayText: (replay.innerText || '').slice(0, 4000),
    };
  `);
}

// Click the file-section toggle (chevron button whose label includes the
// file name). Returns whether the click landed and the post-click editor
// count so the caller can assert the collapse/expand transition.
async function toggleFileSection() {
  return execJS(`
    const replay = document.querySelector('.session-replay-diff') || document;
    const btn = Array.from(replay.querySelectorAll('button'))
      .find((b) => (b.innerText || '').includes('sentinel.ts'));
    if (!btn) return { clicked: false };
    btn.click();
    return { clicked: true };
  `);
}

// Click the collapse band to expand the hidden unchanged region, then
// report whether previously-hidden context lines became visible.
async function expandCollapseBand() {
  return execJS(`
    const replay = document.querySelector('.session-replay-diff') || document;
    const band = replay.querySelector('.cm-collapsedLines');
    if (!band) return { clicked: false };
    band.click();
    return { clicked: true };
  `);
}

async function clickTabByText(tabLabelFragment) {
  return execJS(`
    const frag = ${JSON.stringify(tabLabelFragment)}.toLowerCase();
    const replay = document.querySelector('.session-replay-diff') || document;
    const tab = Array.from(replay.querySelectorAll('button, [role="tab"]'))
      .find((node) => {
        const text = (node.innerText || '').trim().toLowerCase();
        return text.startsWith(frag) && text.length < 30;
      });
    if (!tab) return { clicked: false };
    tab.click();
    return { clicked: true, text: (tab.innerText || '').trim() };
  `);
}

/**
 * Click the first file entry in the Diff tab's file list sidebar.
 * The file list renders each entry with its path as text.
 */
async function clickFirstDiffFileEntry(filePath) {
  return execJS(`
    const search = ${JSON.stringify(filePath)};
    const replay = document.querySelector('.session-replay-diff') || document;
    for (const node of replay.querySelectorAll('button, div[role="button"], li')) {
      const text = (node.innerText || '').trim();
      if (text.includes(search) && text.length < 200) {
        node.click();
        return { clicked: true, text };
      }
    }
    return { clicked: false };
  `);
}

describe("Diff / orgtrack final-diff tab content", function () {
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
        repoName: "diff-content-fixture",
      }),
      "ensureRepoSelected"
    );
  });

  it("renders diff content when only the diff field is stored (no oldContent/newContent)", async function () {
    const { gitRepoPath } = fixtures;
    const sessionId = `e2e-diff-tab-${RUN_ID}`;
    const base = Date.now();

    // 1. Seed chat events so the Diff app has a session to work with.
    unwrap(
      await invokeE2E(
        "seedChatEvents",
        sessionId,
        [makeUserEvent(sessionId, gitRepoPath, new Date(base).toISOString())],
        { stationMode: "agent-station" }
      ),
      "seedChatEvents"
    );

    // 2. Seed a diff-only orgtrack final-diff record. This is the bug shape:
    //    old_content and new_content are null; only `diff` is populated.
    //    The hunk carries a long run of unchanged context lines (so
    //    CodeMirror's collapseUnchanged {margin:3, minSize:10} produces a
    //    clickable "N unchanged lines" band), a one-line change (the
    //    sentinel), and one very long line (so the "giant row" artifact
    //    would manifest here if the SCSS fix regressed).
    const contextLines = Array.from(
      { length: CONTEXT_LINE_COUNT },
      (_unused, index) => `const ctx_${index} = ${index};`
    );
    const changedLineNo = CONTEXT_LINE_COUNT + 1;
    const hunkLineCount = CONTEXT_LINE_COUNT + CONTEXT_LINE_COUNT + 2;
    const unifiedDiff = [
      `--- ${SEEDED_FILE_PATH}`,
      `+++ ${SEEDED_FILE_PATH}`,
      `@@ -1,${hunkLineCount} +1,${hunkLineCount} @@`,
      // Leading unchanged run (>=10) → collapses into a band.
      ...contextLines.map((line) => ` ${line}`),
      `-${SENTINEL_OLD}`,
      `+${SENTINEL_NEW}`,
      ` ${LONG_LINE}`,
      // Trailing unchanged run (>=10) → collapses into a second band.
      ...contextLines.map((line) => ` ${line}`),
    ].join("\n");
    void changedLineNo;

    unwrap(
      await invokeE2E("debugSeedFinalDiffWire", {
        sessionId,
        source: "sdeagent",
        filePath: SEEDED_FILE_PATH,
        diff: unifiedDiff,
      }),
      "debugSeedFinalDiffWire"
    );

    // 3. Open the Diff app.
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

    // 4. The Diff tab is the default-active sub-tab and the single changed
    //    file auto-expands, so the diff renders without any clicks. Best-effort
    //    click the file entry to also exercise the selection path; the core
    //    assertion below does not depend on it.
    await clickTabByText("Diff").catch(() => undefined);
    await clickFirstDiffFileEntry(SEEDED_FILE_PATH).catch(() => undefined);

    // 5. Assert the diff content renders — the sentinel lines (parsed from the
    //    `diff`-only record, with null old/new content) must be visible in the
    //    diff panel. Before the fix this panel was blank.
    await browser.waitUntil(
      async () => {
        const snap = await diffPanelSnapshot();
        return (
          snap.replayText.includes(`SENTINEL_${RUN_ID}_OLD`) &&
          snap.replayText.includes(`SENTINEL_${RUN_ID}_NEW`)
        );
      },
      {
        timeout: DIFF_DETAIL_TIMEOUT_MS,
        interval: 500,
        timeoutMsg: `sentinel diff content never rendered: ${JSON.stringify(
          await diffPanelSnapshot()
        )}`,
      }
    );

    // 6. Structural health: the rendered diff must be the real
    //    collapsible/expandable CodeMirror diff, NOT a blank panel and NOT
    //    a single absurdly-tall row. Wait for the editor to mount, then
    //    snapshot structure.
    let structure = null;
    await browser.waitUntil(
      async () => {
        structure = await diffStructureSnapshot();
        return structure.hasReplayShell && structure.editorCount > 0;
      },
      {
        timeout: DIFF_DETAIL_TIMEOUT_MS,
        interval: 500,
        timeoutMsg: () =>
          `CodeMirror editor never mounted: ${JSON.stringify(structure)}`,
      }
    );

    // 6a. A collapse band ("N unchanged lines") must be produced for the
    //     long unchanged context run — this is the collapsible original
    //     text the user cares about.
    expect(structure.collapseBandCount).toBeGreaterThan(0);

    // 6b. No single rendered code row may be absurdly tall. The "giant row"
    //     artifact stretched the layout instead of scrolling the long line
    //     horizontally; assert every .cm-line stays at a normal height and
    //     that the long line scrolls horizontally instead.
    expect(structure.maxLineHeight).toBeLessThan(MAX_SANE_LINE_HEIGHT_PX);
    expect(structure.horizontallyScrollable).toBe(true);

    // 6c. Clicking the collapse band expands the hidden context — the
    //     previously-collapsed ctx lines become visible.
    const bandBefore = structure.collapseBandCount;
    unwrap(
      (await expandCollapseBand()).clicked
        ? { ok: true }
        : { ok: false, error: "collapse band not clickable" },
      "expandCollapseBand"
    );
    await browser.waitUntil(
      async () => {
        const after = await diffStructureSnapshot();
        // Expanding consumes a band and reveals real context line text.
        return (
          after.collapseBandCount < bandBefore &&
          after.replayText.includes("ctx_0")
        );
      },
      {
        timeout: 10_000,
        interval: 400,
        timeoutMsg: async () =>
          `collapse band never expanded to show context: ${JSON.stringify(
            await diffStructureSnapshot()
          )}`,
      }
    );

    // 6d. The file section is collapsible: clicking its header toggle hides
    //     the editor; clicking again restores it.
    const collapsedSnap = await (async () => {
      unwrap(
        (await toggleFileSection()).clicked
          ? { ok: true }
          : { ok: false, error: "file section toggle not found" },
        "toggleFileSection(collapse)"
      );
      let snap = null;
      await browser.waitUntil(
        async () => {
          snap = await diffStructureSnapshot();
          return snap.editorCount === 0;
        },
        {
          timeout: 10_000,
          interval: 400,
          timeoutMsg: () =>
            `file section never collapsed (editor still mounted): ${JSON.stringify(
              snap
            )}`,
        }
      );
      return snap;
    })();
    expect(collapsedSnap.editorCount).toBe(0);

    unwrap(
      (await toggleFileSection()).clicked
        ? { ok: true }
        : { ok: false, error: "file section toggle not found" },
      "toggleFileSection(expand)"
    );
    await browser.waitUntil(
      async () => (await diffStructureSnapshot()).editorCount > 0,
      {
        timeout: 10_000,
        interval: 400,
        timeoutMsg: "file section never re-expanded",
      }
    );
  });
});
