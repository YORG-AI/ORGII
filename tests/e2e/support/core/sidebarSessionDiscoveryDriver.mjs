/**
 * Rendered sidebar driver for the Issue #443 normal-user regression matrix.
 *
 * Debug helpers are restricted to deterministic setup/observation. Grouping,
 * searching, source toggling, pagination, and session opening all use the
 * production controls a user clicks.
 */
import {
  assertNoReplayFatalError,
  clickRenderedSelector,
  execJS,
  getRpcCounts,
  invokeE2E,
  invokeTauriCommand,
  prepareExternalReplayRenderedUi,
  refreshSessionRosterViaUi,
  renderedSelectorSnapshot,
  rpcCountDelta,
  setRenderedInputValue,
  waitForRenderedSelector,
  waitForRenderedSelectorAbsent,
} from "./externalReplayUiDriver.mjs";

export const SIDEBAR_SECTIONS = Object.freeze({
  sde: "sde",
  managedCli: "cli",
  codex: "external_history:codex_app",
  cursor: "external_history:cursor_ide",
  openCode: "external_history:opencode",
});

export const SIDEBAR_CATEGORIES = Object.freeze({
  sde: "rust_agent:sde",
  managedCli: "cli_agent",
  codex: "external_history:codex_app",
  cursor: "external_history:cursor_ide",
  openCode: "external_history:opencode",
});

const SIDEBAR_SEARCH_INPUT = '[data-testid="workstation-sidebar-search-input"]';
const GROUP_BY_TRIGGER = '[data-testid="sidebar-session-filter-button"]';
const GROUP_BY_AGENT = '[data-testid="sidebar-group-by-byAgent"]';
const RUNTIME_ROW = '[data-testid="sidebar-runtime"]';
const RUNTIME_SCANNING_TAB = '[data-testid="data-source-view-scanning"]';
const EXTERNAL_SESSIONS_SWITCH =
  'button[role="switch"][aria-label="External sessions"]';
const NEW_SESSION_ROW = '[data-testid="sidebar-new-session"]';
const SESSION_ROW_PREFIX = "sidebar-session-item-";
const NATIVE_EXTERNAL_REPLAY_COMMANDS = [
  "external_replay_open_window",
  "external_replay_poll_delta",
  "external_replay_read_window",
  "external_replay_query_window",
  "external_replay_handoff",
  "external_replay_prewarm_window",
  "external_replay_release",
  "external_replay_read_payload_range",
  "external_replay_stream_export",
  "external_replay_cloud_prepare",
  "external_replay_cloud_read_batch",
  "external_replay_cloud_prefix_hash",
  "external_replay_cloud_release",
];

function cssAttributeString(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

export function fixtureIds(fixtures) {
  return fixtures.map((fixture) => fixture.sessionId);
}

export async function prepareSidebarDiscoveryRenderedUi(repoPath) {
  await browser.setTimeout({ script: 240_000 });
  await browser.waitUntil(
    async () => {
      try {
        return Boolean(
          await browser.executeScript("return !!window.localStorage;", [])
        );
      } catch {
        return false;
      }
    },
    {
      timeout: 60_000,
      timeoutMsg: "sidebar fixture could not access localStorage",
    }
  );

  // Deterministic setup only. A reload lets the real atomWithStorage readers
  // consume these values before the sidebar mounts; every behavior assertion
  // below still uses rendered controls and production Tauri commands.
  await browser.executeScript(
    `
      localStorage.setItem("orgii:auth_skipped", "1");
      localStorage.setItem("orgii:dataSourceConfig", "{}");
      localStorage.setItem("orgii:externalSessionsEnabled", "true");
      localStorage.setItem("orgii:sidebarIncludeExternal", "true");
      localStorage.setItem("orgii:sidebarGroupBy", JSON.stringify("byTime"));
      return true;
    `,
    []
  );
  await browser.refresh();
  await prepareExternalReplayRenderedUi(repoPath);
}

export async function rescanSidebarProviderFixtures() {
  for (const source of ["codex_app", "opencode", "cursor_ide"]) {
    await invokeTauriCommand("external_history_rescan_source", {
      source,
      clear: false,
    });
  }
}

export async function refreshSidebarFromRenderedMenu() {
  await refreshSessionRosterViaUi();
}

export async function selectByAgentFromRenderedMenu() {
  await clickRenderedSelector(GROUP_BY_TRIGGER, {
    label: "sidebar Group by trigger",
  });
  await clickRenderedSelector(GROUP_BY_AGENT, {
    timeout: 10_000,
    label: "sidebar By Agent option",
  });
  await waitForRenderedSelectorAbsent(GROUP_BY_AGENT, {
    label: "sidebar By Agent menu option",
  });
}

export async function expandSidebarSection(sectionId) {
  const selector = `[data-sidebar-section-toggle="${sectionId}"]`;
  await waitForRenderedSelector(selector, {
    timeout: 60_000,
    label: `sidebar section ${sectionId}`,
  });
  if (
    (await renderedSelectorSnapshot(selector))?.attributes["aria-expanded"] ===
    "false"
  ) {
    await clickRenderedSelector(selector, {
      label: `sidebar section ${sectionId}`,
    });
    await browser.waitUntil(
      async () =>
        (await renderedSelectorSnapshot(selector))?.attributes[
          "aria-expanded"
        ] === "true",
      {
        timeout: 10_000,
        timeoutMsg: `sidebar section ${sectionId} did not expand`,
      }
    );
  }
}

export async function sidebarSectionSnapshot(sectionId) {
  return execJS(`
    return (() => {
      const section = document.querySelector(
        '[data-sidebar-section-id="${cssAttributeString(sectionId)}"]'
      );
      if (!section) return null;
      const rows = Array.from(
        section.querySelectorAll('[data-menu-item-id]')
      ).map((row) => ({
        id: row.getAttribute('data-menu-item-id') || '',
        testId: row.getAttribute('data-testid') || '',
        text: (row.textContent || '').replace(/\\s+/g, ' ').trim(),
      }));
      return {
        sectionId: ${JSON.stringify(sectionId)},
        rows,
        sessionRows: rows.filter((row) =>
          row.testId.startsWith(${JSON.stringify(SESSION_ROW_PREFIX)})
        ),
      };
    })();
  `);
}

function sessionIdsFromSnapshot(snapshot) {
  return (snapshot?.sessionRows ?? []).map((row) => row.id);
}

function fixtureCount(snapshot, expectedIds) {
  const expected = new Set(expectedIds);
  return sessionIdsFromSnapshot(snapshot).filter((id) => expected.has(id))
    .length;
}

export async function waitForSectionFixtureCount({
  sectionId,
  expectedIds,
  expectedFixtureCount,
  expectedTotalCount,
  label,
}) {
  await expandSidebarSection(sectionId);
  let snapshot = null;
  try {
    await browser.waitUntil(
      async () => {
        snapshot = await sidebarSectionSnapshot(sectionId);
        if (!snapshot) return false;
        const fixtureMatches = fixtureCount(snapshot, expectedIds);
        const totalMatches =
          expectedTotalCount == null ||
          snapshot.sessionRows.length === expectedTotalCount;
        return fixtureMatches === expectedFixtureCount && totalMatches;
      },
      {
        timeout: 90_000,
        interval: 200,
        timeoutMsg:
          `${label} did not reach fixture=${expectedFixtureCount}` +
          (expectedTotalCount == null ? "" : ` total=${expectedTotalCount}`),
      }
    );
  } catch (error) {
    snapshot = await sidebarSectionSnapshot(sectionId);
    throw new Error(
      `${error?.message ?? error}; final rendered section=${JSON.stringify(
        snapshot
      )}`
    );
  }
  assertNoDuplicateSessionRows(snapshot, label);
  return snapshot;
}

export function assertNoDuplicateSessionRows(snapshot, label) {
  const ids = sessionIdsFromSnapshot(snapshot);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicates.length > 0) {
    throw new Error(
      `${label} rendered duplicate session rows: ${JSON.stringify(duplicates)}`
    );
  }
}

export function assertHumanReadableFixtureTitles(snapshot, fixtures, label) {
  const fixtureById = new Map(
    fixtures.map((fixture) => [fixture.sessionId, fixture])
  );
  const badTitlePatterns = [
    /\b(?:exec_command|shell_command|update_plan|read_file|grep)\b/i,
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i,
    /(?:\.jsonl\b|opencode\.db\b|ses_e2e_sidebar_)/i,
  ];
  for (const row of snapshot?.sessionRows ?? []) {
    const fixture = fixtureById.get(row.id);
    if (!fixture) continue;
    if (!row.text.includes(fixture.title)) {
      throw new Error(
        `${label} row ${row.id} did not render its human title ${JSON.stringify(
          fixture.title
        )}: ${JSON.stringify(row.text)}`
      );
    }
    const badPattern = badTitlePatterns.find((pattern) =>
      pattern.test(row.text)
    );
    if (badPattern) {
      throw new Error(
        `${label} row ${row.id} exposed a raw/tool/file label matching ${badPattern}: ${JSON.stringify(
          row.text
        )}`
      );
    }
  }
}

function loadMoreSelector(category) {
  return `[data-menu-item-id="load-more-${category}"]`;
}

export async function assertUniqueLoadMore(sectionId, category, label) {
  const snapshot = await sidebarSectionSnapshot(sectionId);
  const expectedId = `load-more-${category}`;
  const matches = (snapshot?.rows ?? []).filter((row) => row.id === expectedId);
  if (matches.length !== 1) {
    throw new Error(
      `${label} expected exactly one ${expectedId} row, got ${matches.length}: ${JSON.stringify(
        snapshot
      )}`
    );
  }
  return $(loadMoreSelector(category));
}

export async function assertLoadMoreAbsent(sectionId, category, label) {
  const snapshot = await sidebarSectionSnapshot(sectionId);
  const expectedId = `load-more-${category}`;
  const matches = (snapshot?.rows ?? []).filter((row) => row.id === expectedId);
  if (matches.length !== 0) {
    throw new Error(
      `${label} left ${matches.length} exhausted ${expectedId} row(s): ${JSON.stringify(
        snapshot
      )}`
    );
  }
}

export async function clickLoadMoreAndWait({
  sectionId,
  category,
  expectedIds,
  previousFixtureCount,
  expectedFixtureCount,
  label,
  doubleClick = false,
  expectedRpcCommand,
}) {
  const beforeRpc = expectedRpcCommand ? await getRpcCounts() : null;
  await assertUniqueLoadMore(sectionId, category, label);
  await clickRenderedSelector(loadMoreSelector(category), {
    label: `${label} Load more`,
    clickCount: doubleClick ? 2 : 1,
  });

  let snapshot = null;
  try {
    await browser.waitUntil(
      async () => {
        snapshot = await sidebarSectionSnapshot(sectionId);
        const count = fixtureCount(snapshot, expectedIds);
        return count === expectedFixtureCount;
      },
      {
        timeout: 90_000,
        interval: 100,
        timeoutMsg: `${label} did not grow fixture rows from ${previousFixtureCount} to ${expectedFixtureCount}`,
      }
    );
  } catch (error) {
    snapshot = await sidebarSectionSnapshot(sectionId);
    throw new Error(
      `${error?.message ?? error}; final rendered section=${JSON.stringify(
        snapshot
      )}`
    );
  }
  const currentCount = fixtureCount(snapshot, expectedIds);
  const expectedGrowth = expectedFixtureCount - previousFixtureCount;
  const actualGrowth = currentCount - previousFixtureCount;
  if (actualGrowth !== expectedGrowth) {
    throw new Error(
      `${label} expected exact growth +${expectedGrowth}, got +${actualGrowth}: ${previousFixtureCount} -> ${currentCount}`
    );
  }
  assertNoDuplicateSessionRows(snapshot, label);
  if (doubleClick) {
    await browser.pause(500);
    const settled = await sidebarSectionSnapshot(sectionId);
    const settledCount = fixtureCount(settled, expectedIds);
    if (settledCount !== expectedFixtureCount) {
      throw new Error(
        `${label} changed after double-click settled: ${expectedFixtureCount} -> ${settledCount}`
      );
    }
  }
  if (expectedRpcCommand) {
    const afterRpc = await getRpcCounts();
    const delta = rpcCountDelta(afterRpc, beforeRpc, expectedRpcCommand);
    if (delta !== 1) {
      throw new Error(
        `${label} expected one ${expectedRpcCommand} request, got ${delta}`
      );
    }
  }
  return snapshot;
}

export async function assertCursorGhostAbsent() {
  const ghostSessionId = process.env.E2E_SIDEBAR_CURSOR_GHOST_SESSION_ID;
  if (!ghostSessionId) {
    throw new Error("E2E_SIDEBAR_CURSOR_GHOST_SESSION_ID is missing");
  }
  const ghost = await execJS(`
    return {
      row: !!document.querySelector(
        '[data-menu-item-id="${cssAttributeString(ghostSessionId)}"]'
      ),
    };
  `);
  if (ghost?.row) {
    throw new Error(
      `provider refresh left a stale Cursor App ghost: ${JSON.stringify(ghost)}`
    );
  }
}

async function sidebarSearchInput() {
  await waitForRenderedSelector(SIDEBAR_SEARCH_INPUT, {
    label: "sidebar search input",
  });
}

async function renderedSidebarSearchValue() {
  return execJS(
    `return document.querySelector(${JSON.stringify(
      SIDEBAR_SEARCH_INPUT
    )})?.value ?? null;`
  );
}

export async function typeSidebarSearchTerm(term) {
  await sidebarSearchInput();
  // Replace any persisted text from a prior app run before exercising the
  // production React input path. tauri-wd 0.1.3 assigns `el.value` directly,
  // which React's value tracker ignores; the helper uses the native setter
  // and still dispatches the real production input/change handlers.
  await setRenderedInputValue(SIDEBAR_SEARCH_INPUT, term, {
    label: "sidebar search input",
  });
  try {
    await browser.waitUntil(
      async () => (await renderedSidebarSearchValue()) === term,
      {
        timeout: 10_000,
        timeoutMsg: `sidebar search did not accept ${JSON.stringify(term)}`,
      }
    );
  } catch (error) {
    throw new Error(
      `sidebar search expected ${JSON.stringify(term)}, got ${JSON.stringify(
        await renderedSidebarSearchValue()
      )}: ${error?.message ?? error}`
    );
  }
}

export async function clearSidebarSearchTerm() {
  await sidebarSearchInput();
  await setRenderedInputValue(SIDEBAR_SEARCH_INPUT, "", {
    label: "sidebar search input",
  });
  await browser.waitUntil(
    async () =>
      execJS(
        `return document.querySelector(${JSON.stringify(
          SIDEBAR_SEARCH_INPUT
        )})?.value === "";`
      ),
    {
      timeout: 10_000,
      timeoutMsg: "sidebar search did not clear through keyboard input",
    }
  );
}

export async function waitForSidebarRowPresence(sessionId, present, label) {
  const selector = `[data-testid="sidebar-session-item-${sessionId}"]`;
  await browser.waitUntil(
    async () => Boolean(await renderedSelectorSnapshot(selector)) === present,
    {
      timeout: 60_000,
      interval: 200,
      timeoutMsg: `${label} did not become ${present ? "visible" : "hidden"}`,
    }
  );
}

async function openRuntimeScanningFromSidebar() {
  await clickRenderedSelector(RUNTIME_ROW, {
    label: "Runtime sidebar row",
  });
  await clickRenderedSelector(RUNTIME_SCANNING_TAB, {
    timeout: 30_000,
    label: "Runtime Scanning tab",
  });
  await waitForRenderedSelector(EXTERNAL_SESSIONS_SWITCH, {
    timeout: 30_000,
    label: "External sessions switch",
  });
}

export async function verifySearchSurvivesExternalSessionsToggle({
  term,
  externalSessionId,
  externalSectionId,
}) {
  await typeSidebarSearchTerm(term);
  await expandSidebarSection(externalSectionId);
  await waitForSidebarRowPresence(
    externalSessionId,
    true,
    "external search result before master toggle"
  );

  await openRuntimeScanningFromSidebar();
  if (
    (await renderedSelectorSnapshot(EXTERNAL_SESSIONS_SWITCH))?.attributes[
      "aria-checked"
    ] !== "true"
  ) {
    throw new Error("External sessions master switch was not initially on");
  }
  await clickRenderedSelector(EXTERNAL_SESSIONS_SWITCH, {
    label: "External sessions switch",
  });
  await browser.waitUntil(
    async () =>
      (await renderedSelectorSnapshot(EXTERNAL_SESSIONS_SWITCH))?.attributes[
        "aria-checked"
      ] === "false",
    {
      timeout: 10_000,
      timeoutMsg: "External sessions master switch did not turn off",
    }
  );
  await sidebarSearchInput();
  if ((await renderedSidebarSearchValue()) !== term) {
    throw new Error(
      "sidebar search term was lost when external sessions turned off"
    );
  }
  await waitForSidebarRowPresence(
    externalSessionId,
    false,
    "external search result after master switch off"
  );

  await waitForRenderedSelector(EXTERNAL_SESSIONS_SWITCH, {
    timeout: 10_000,
    label: "restored External sessions switch",
  });
  await clickRenderedSelector(EXTERNAL_SESSIONS_SWITCH, {
    label: "restored External sessions switch",
  });
  await browser.waitUntil(
    async () =>
      (await renderedSelectorSnapshot(EXTERNAL_SESSIONS_SWITCH))?.attributes[
        "aria-checked"
      ] === "true",
    {
      timeout: 10_000,
      timeoutMsg: "External sessions master switch did not turn back on",
    }
  );
  await sidebarSearchInput();
  if ((await renderedSidebarSearchValue()) !== term) {
    throw new Error(
      "sidebar search term was lost when external sessions turned on"
    );
  }
  await expandSidebarSection(externalSectionId);
  await waitForSidebarRowPresence(
    externalSessionId,
    true,
    "external search result after master switch on"
  );

  await clickRenderedSelector(NEW_SESSION_ROW, {
    label: "New Session sidebar row",
  });
  await clearSidebarSearchTerm();
}

export async function waitForRenderedSessionRow(sessionId, sectionId, label) {
  await expandSidebarSection(sectionId);
  const selector = `[data-testid="sidebar-session-item-${sessionId}"]`;
  await waitForRenderedSelector(selector, {
    timeout: 60_000,
    label: `${label} sidebar row`,
  });
}

export async function openRenderedSidebarSession({
  sessionId,
  sectionId,
  label,
  marker,
  expectChatEvents = false,
  assertNativeReplayBoundary = false,
}) {
  await waitForRenderedSessionRow(sessionId, sectionId, label);
  const beforeRpc = assertNativeReplayBoundary ? await getRpcCounts() : null;
  await clickRenderedSelector(
    `[data-testid="sidebar-session-item-${sessionId}"]`,
    { timeout: 60_000, label: `${label} sidebar row` }
  );

  let state = null;
  await browser.waitUntil(
    async () => {
      state = await invokeE2E("inspectChatState");
      if (state?.activeSessionId !== sessionId) return false;
      if (state?.runtimeError) return false;
      if (expectChatEvents && Number(state?.chatEventCount ?? 0) < 1) {
        return false;
      }
      return true;
    },
    {
      timeout: 120_000,
      interval: 150,
      timeoutMsg: `${label} did not respond to its rendered sidebar click`,
    }
  );

  if (marker) {
    await browser.waitUntil(
      async () =>
        Boolean(
          await execJS(
            `return document.querySelector('[data-testid="chat-panel"]')?.textContent?.includes(${JSON.stringify(
              marker
            )}) === true;`
          )
        ),
      {
        timeout: 120_000,
        interval: 150,
        timeoutMsg: `${label} did not render ${JSON.stringify(marker)}`,
      }
    );
  }
  await assertNoReplayFatalError(label);

  if (assertNativeReplayBoundary) {
    const afterRpc = await getRpcCounts();
    const deltas = Object.fromEntries(
      NATIVE_EXTERNAL_REPLAY_COMMANDS.map((command) => [
        command,
        rpcCountDelta(afterRpc, beforeRpc, command),
      ])
    );
    if (Object.values(deltas).some((delta) => delta !== 0)) {
      throw new Error(
        `${label} crossed into external replay RPCs: ${JSON.stringify(deltas)}`
      );
    }
  }
  return state;
}

export async function deleteFixtureSessions({
  sdeSessionIds,
  managedSessionIds,
}) {
  const failures = [];
  for (const sessionId of managedSessionIds) {
    try {
      await invokeTauriCommand("cli_agent_delete", { sessionId });
    } catch (error) {
      failures.push(`managed ${sessionId}: ${error?.message ?? error}`);
    }
  }
  for (const sessionId of sdeSessionIds) {
    try {
      await invokeTauriCommand("agent_delete_session", { sessionId });
    } catch (error) {
      failures.push(`SDE ${sessionId}: ${error?.message ?? error}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`sidebar fixture cleanup failed:\n${failures.join("\n")}`);
  }
}
