import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { invokeTauriCommand } from "./externalReplayUiDriver.mjs";
import { verifyRenderedIncludeExternalControl } from "./sidebarExternalVisibilityDriver.mjs";
import {
  SIDEBAR_CATEGORIES,
  SIDEBAR_SECTIONS,
  assertCursorGhostAbsent,
  assertHumanReadableFixtureTitles,
  assertLoadMoreAbsent,
  assertUniqueLoadMore,
  clickLoadMoreAndWait,
  deleteFixtureSessions,
  fixtureIds,
  openRenderedSidebarSession,
  prepareSidebarDiscoveryRenderedUi,
  refreshSidebarFromRenderedMenu,
  rescanSidebarProviderFixtures,
  selectByAgentFromRenderedMenu,
  verifySearchSurvivesExternalSessionsToggle,
  waitForSectionFixtureCount,
  waitForSidebarRowPresence,
} from "./sidebarSessionDiscoveryDriver.mjs";
import {
  clickGroupedLoadMoreAndWait,
  selectRenderedSidebarGrouping,
  waitForIsolatedGroupedSection,
} from "./sidebarSessionGroupingDriver.mjs";

const INITIAL_PAGE_SIZE = 10;
const POLLUTED_CODEX_CACHE_SESSION_ID =
  "codexapp-e2e-sidebar-polluted-cache-only";

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sessionsDatabasePath() {
  const orgiiHome = process.env.ORGII_HOME;
  if (!orgiiHome) {
    throw new Error("ORGII_HOME is required for sidebar SQLite fixtures");
  }
  return join(orgiiHome, "sessions.db");
}

function runSessionsSql(statements) {
  return execFileSync("/usr/bin/sqlite3", [sessionsDatabasePath()], {
    encoding: "utf8",
    input: `PRAGMA busy_timeout=15000;\n${statements.join("\n")}\n`,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function seedManagedChunkTranscript(fixture) {
  const marker = "E2E Sidebar managed chunk rendered response";
  const createdAt = new Date().toISOString();
  const seeded = runSessionsSql([
    `UPDATE code_sessions
       SET transcript_source='chunks'
     WHERE session_id=${sqlLiteral(fixture.sessionId)};`,
    `INSERT INTO code_session_chunks (
       chunk_id, session_id, action_type, function, args_json, result_json,
       thread_id, process_id, sequence, created_at
     ) VALUES (
       ${sqlLiteral(`${fixture.sessionId}-user`)},
       ${sqlLiteral(fixture.sessionId)},
       'raw',
       'user_message',
       '{}',
       ${sqlLiteral(
         JSON.stringify({
           type: "user",
           message: { content: fixture.title, role: "user" },
         })
       )},
       NULL, NULL, 0, ${sqlLiteral(createdAt)}
     );`,
    `INSERT INTO code_session_chunks (
       chunk_id, session_id, action_type, function, args_json, result_json,
       thread_id, process_id, sequence, created_at
     ) VALUES (
       ${sqlLiteral(`${fixture.sessionId}-assistant`)},
       ${sqlLiteral(fixture.sessionId)},
       'assistant',
       'assistant_message',
       '{}',
       ${sqlLiteral(JSON.stringify({ content: marker }))},
       NULL, NULL, 1, ${sqlLiteral(createdAt)}
     );`,
    `SELECT COUNT(*) FROM code_session_chunks
      WHERE session_id=${sqlLiteral(fixture.sessionId)};`,
  ]);
  if (seeded.split("\n").at(-1) !== "2") {
    throw new Error(`failed to seed managed replay chunks: ${seeded}`);
  }
  fixture.marker = marker;
}

function seedPollutedCodexCacheRow() {
  const sourceSessionId = "e2e-sidebar-polluted-cache-only";
  const now = Date.now();
  const inserted = runSessionsSql([
    `INSERT OR REPLACE INTO imported_history_session_cache (
       source, source_session_id, session_id, source_path, source_record_key,
       source_mtime_ms, source_size_bytes, source_fingerprint, parser_version,
       name, created_at_ms, updated_at_ms, model, input_tokens, output_tokens,
       cache_read_tokens, cache_write_tokens, repo_path, branch, files_changed,
       lines_added, lines_removed, touched_files_json, listable,
       source_metadata_json, parent_session_id, updated_at
     ) VALUES (
       'codex_app', ${sqlLiteral(sourceSessionId)},
       ${sqlLiteral(POLLUTED_CODEX_CACHE_SESSION_ID)},
       '/missing/e2e-polluted-codex.jsonl', 'file:missing',
       ${now}, 1, 'polluted-cache-only', 1,
       'Polluted Codex cache ghost', ${now}, ${now}, '', 0, 0, 0, 0,
       '', '', 0, 0, 0, '[]', 1, '{}', '', ${sqlLiteral(
         new Date(now).toISOString()
       )}
     );`,
    `SELECT COUNT(*) FROM imported_history_session_cache
      WHERE source='codex_app'
        AND session_id=${sqlLiteral(POLLUTED_CODEX_CACHE_SESSION_ID)};`,
  ]);
  if (inserted.split("\n").at(-1) !== "1") {
    throw new Error("failed to seed polluted Codex cache row");
  }
}

function assertPollutedCodexCachePruned() {
  const count = runSessionsSql([
    `SELECT COUNT(*) FROM imported_history_session_cache
      WHERE source='codex_app'
        AND session_id=${sqlLiteral(POLLUTED_CODEX_CACHE_SESSION_ID)};`,
  ]);
  if (count.split("\n").at(-1) !== "0") {
    throw new Error(`polluted Codex cache row survived rescan: ${count}`);
  }
}

function parseFixtureManifest(name, minimumLength) {
  const raw = process.env[name];
  if (!raw) {
    throw new Error(
      `${name} is missing; run through the isolated WDIO harness so no real provider HOME is scanned`
    );
  }
  let fixtures = null;
  try {
    fixtures = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${name} is invalid JSON: ${error?.message ?? error}`);
  }
  if (!Array.isArray(fixtures) || fixtures.length < minimumLength) {
    throw new Error(
      `${name} requires at least ${minimumLength} fixtures, got ${fixtures?.length ?? "non-array"}`
    );
  }
  return fixtures;
}

function newestFixtures(fixtures, count) {
  return fixtures
    .slice()
    .sort(
      (left, right) =>
        Number(right.updatedAtMs ?? 0) - Number(left.updatedAtMs ?? 0)
    )
    .slice(0, count);
}

function buildSdeSessionRecord({ sessionId, title, updatedAt, repoPath }) {
  const timestamp = new Date(updatedAt).toISOString();
  return {
    sessionId,
    name: title,
    status: "idle",
    model: null,
    accountId: null,
    nativeHarnessType: null,
    userInput: title,
    totalTokens: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    sessionType: "sde",
    channel: null,
    chatId: null,
    workspacePath: repoPath,
    orgId: null,
    projectId: null,
    projectName: null,
    workItemId: null,
    agentRole: null,
    worktreePath: null,
    worktreeBranch: null,
    baseBranch: null,
    mergeStatus: null,
    projectSlug: null,
    agentDefinitionId: "builtin:sde",
    orgMemberId: null,
    parentSessionId: null,
    parentEventId: null,
    workspaceAdditionalJson: "{}",
    keySource: "own_key",
    agentExecMode: null,
    draftText: null,
    replyTargetEventId: null,
    pinned: false,
  };
}

async function seedSdeSessions(repoPath, runToken, fixtures) {
  const timestampBase = Date.now() + 60_000;
  for (let index = 1; index <= 21; index += 1) {
    const ordinal = String(index).padStart(2, "0");
    const sessionId = `sdeagent-e2e-sidebar-${runToken}-${ordinal}`;
    const title = `E2E Sidebar SDE Architecture Review ${ordinal}`;
    const updatedAtMs = timestampBase + index * 1_000;
    await invokeTauriCommand("agent_save_session", {
      session: buildSdeSessionRecord({
        sessionId,
        title,
        updatedAt: updatedAtMs,
        repoPath,
      }),
    });
    fixtures.push({ sessionId, title, updatedAtMs });
  }
  return fixtures;
}

async function seedManagedOpenCodeSessions(repoPath, fixtures) {
  for (let index = 1; index <= 21; index += 1) {
    const ordinal = String(index).padStart(2, "0");
    const title = `E2E Sidebar Managed OpenCode Review ${ordinal}`;
    const created = await invokeTauriCommand("cli_agent_create", {
      params: {
        name: title,
        platform: "opencode",
        model: "e2e-opencode",
        accountId: null,
        repoPath,
        background: false,
        isolate: false,
        keySource: "own_key",
      },
    });
    const sessionId = created?.sessionId ?? created?.session_id;
    if (!sessionId?.startsWith("cliagent-")) {
      throw new Error(
        `cli_agent_create returned an invalid managed id: ${JSON.stringify(created)}`
      );
    }
    fixtures.push({
      sessionId,
      title,
      updatedAtMs:
        Date.parse(created.updatedAt ?? created.updated_at ?? "") || 0,
    });
    // Preserve a deterministic creation order even on filesystems whose clock
    // resolution is coarser than one Tauri round trip.
    await browser.pause(5);
  }
  return fixtures;
}

async function verifyInitialCategory({ sectionId, category, fixtures, label }) {
  const newest = newestFixtures(fixtures, INITIAL_PAGE_SIZE);
  const snapshot = await waitForSectionFixtureCount({
    sectionId,
    expectedIds: fixtureIds(fixtures),
    expectedFixtureCount: INITIAL_PAGE_SIZE,
    expectedTotalCount: INITIAL_PAGE_SIZE,
    label,
  });
  const visibleFixtureIds = new Set(snapshot.sessionRows.map((row) => row.id));
  for (const fixture of newest) {
    if (!visibleFixtureIds.has(fixture.sessionId)) {
      throw new Error(
        `${label} initial page missed newest fixture ${fixture.sessionId}`
      );
    }
  }
  assertHumanReadableFixtureTitles(snapshot, fixtures, label);
  await assertUniqueLoadMore(sectionId, category, label);
  return snapshot;
}

async function verifyThreePageCategory({
  sectionId,
  category,
  fixtures,
  label,
  firstPageDoubleClick = false,
  firstPageRpcCommand,
}) {
  await verifyInitialCategory({ sectionId, category, fixtures, label });
  const expectedIds = fixtureIds(fixtures);
  const secondPage = await clickLoadMoreAndWait({
    sectionId,
    category,
    expectedIds,
    previousFixtureCount: 10,
    expectedFixtureCount: 20,
    label: `${label} second page`,
    doubleClick: firstPageDoubleClick,
    expectedRpcCommand: firstPageRpcCommand,
  });
  assertHumanReadableFixtureTitles(
    secondPage,
    fixtures,
    `${label} after second page`
  );
  await assertUniqueLoadMore(sectionId, category, `${label} before final page`);

  const completeCatalog = await clickLoadMoreAndWait({
    sectionId,
    category,
    expectedIds,
    previousFixtureCount: 20,
    expectedFixtureCount: 21,
    label: `${label} final page`,
  });
  assertHumanReadableFixtureTitles(
    completeCatalog,
    fixtures,
    `${label} complete catalog`
  );
  await assertLoadMoreAbsent(sectionId, category, `${label} exhausted catalog`);
  return completeCatalog;
}

export class SidebarSessionFixtureScenario {
  constructor(repoPath) {
    this.repoPath = repoPath;
    this.codexFixtures = [];
    this.openCodeFixtures = [];
    this.cursorFixtures = [];
    this.sdeFixtures = [];
    this.managedFixtures = [];
  }

  get cleanupIds() {
    return {
      sdeSessionIds: fixtureIds(this.sdeFixtures),
      managedSessionIds: fixtureIds(this.managedFixtures),
    };
  }

  async setup() {
    if (process.env.E2E_SIDEBAR_DISCOVERY_FIXTURE_READY !== "1") {
      throw new Error(
        "sidebar discovery fixture is not ready; use an isolated WDIO run without a real Issue 272/provider HOME override"
      );
    }
    this.codexFixtures = parseFixtureManifest("E2E_SIDEBAR_CODEX_FIXTURES", 21);
    this.openCodeFixtures = parseFixtureManifest(
      "E2E_SIDEBAR_OPENCODE_FIXTURES",
      21
    );
    const cursorFixtureRaw = process.env.E2E_SIDEBAR_CURSOR_FIXTURE;
    if (!cursorFixtureRaw) {
      throw new Error("E2E_SIDEBAR_CURSOR_FIXTURE is missing");
    }
    this.cursorFixtures = [JSON.parse(cursorFixtureRaw)];

    await prepareSidebarDiscoveryRenderedUi(this.repoPath);
    const runToken = `${process.pid}-${Date.now().toString(36)}`;
    await seedSdeSessions(this.repoPath, runToken, this.sdeFixtures);
    await seedManagedOpenCodeSessions(this.repoPath, this.managedFixtures);
    seedManagedChunkTranscript(this.managedFixtures.at(-1));
    seedPollutedCodexCacheRow();

    await rescanSidebarProviderFixtures();
    await refreshSidebarFromRenderedMenu();
    await selectByAgentFromRenderedMenu();
  }

  async verifySearchAndMasterPolicy() {
    const searchSentinel = this.codexFixtures.find(
      (fixture) => fixture.searchSentinel
    );
    if (!searchSentinel) {
      throw new Error("Codex fixture manifest has no search sentinel");
    }
    await verifySearchSurvivesExternalSessionsToggle({
      term: searchSentinel.title,
      externalSessionId: searchSentinel.sessionId,
      externalSectionId: SIDEBAR_SECTIONS.codex,
    });
    await selectByAgentFromRenderedMenu();
    await verifyRenderedIncludeExternalControl({
      externalSessionId: newestFixtures(this.codexFixtures, 1)[0].sessionId,
      externalSectionId: SIDEBAR_SECTIONS.codex,
      nativeSessionId: newestFixtures(this.sdeFixtures, 1)[0].sessionId,
      nativeSectionId: SIDEBAR_SECTIONS.sde,
    });
  }

  async verifyCatalogPagination() {
    // The ghost fixture is a real Cursor state/index pair. Repeat the complete
    // rendered refresh cycle twice so a one-refresh grace/cache path cannot
    // leak the non-replayable composer shell back into the sidebar.
    for (let cycle = 1; cycle <= 2; cycle += 1) {
      await rescanSidebarProviderFixtures();
      await refreshSidebarFromRenderedMenu();
      await selectByAgentFromRenderedMenu();
      await assertCursorGhostAbsent();
    }
    assertPollutedCodexCachePruned();
    await waitForSidebarRowPresence(
      POLLUTED_CODEX_CACHE_SESSION_ID,
      false,
      "polluted Codex cache-only row after rescan"
    );
    await waitForSectionFixtureCount({
      sectionId: SIDEBAR_SECTIONS.cursor,
      expectedIds: fixtureIds(this.cursorFixtures),
      expectedFixtureCount: 1,
      expectedTotalCount: 1,
      label: "Cursor App valid conversation",
    }).then((snapshot) =>
      assertHumanReadableFixtureTitles(
        snapshot,
        this.cursorFixtures,
        "Cursor App valid conversation"
      )
    );

    const sdeSnapshot = await verifyThreePageCategory({
      sectionId: SIDEBAR_SECTIONS.sde,
      category: SIDEBAR_CATEGORIES.sde,
      fixtures: this.sdeFixtures,
      label: "SDE Agent",
    });
    const managedSnapshot = await verifyThreePageCategory({
      sectionId: SIDEBAR_SECTIONS.managedCli,
      category: SIDEBAR_CATEGORIES.managedCli,
      fixtures: this.managedFixtures,
      label: "CLI Agent managed OpenCode",
    });
    await verifyThreePageCategory({
      sectionId: SIDEBAR_SECTIONS.codex,
      category: SIDEBAR_CATEGORIES.codex,
      fixtures: this.codexFixtures,
      label: "Codex App",
      firstPageDoubleClick: true,
      firstPageRpcCommand: "session_external_history_sidebar_list",
    });
    const openCodeSnapshot = await verifyThreePageCategory({
      sectionId: SIDEBAR_SECTIONS.openCode,
      category: SIDEBAR_CATEGORIES.openCode,
      fixtures: this.openCodeFixtures,
      label: "imported OpenCode",
    });

    const managedIds = new Set(fixtureIds(this.managedFixtures));
    const importedIds = new Set(fixtureIds(this.openCodeFixtures));
    if (
      managedSnapshot.sessionRows.some((row) => importedIds.has(row.id)) ||
      openCodeSnapshot.sessionRows.some((row) => managedIds.has(row.id)) ||
      managedSnapshot.sessionRows.some((row) =>
        row.id.startsWith("opencodeapp-")
      ) ||
      openCodeSnapshot.sessionRows.some((row) => row.id.startsWith("cliagent-"))
    ) {
      throw new Error(
        "managed OpenCode and imported OpenCode rows were mixed between sections"
      );
    }
    if (sdeSnapshot.sessionRows.some((row) => row.id.startsWith("cliagent-"))) {
      throw new Error("native SDE section contained a managed CLI row");
    }
  }

  async verifyRenderedGroupingPagination() {
    const byTimeIds = [
      ...fixtureIds(this.sdeFixtures),
      ...fixtureIds(this.managedFixtures),
    ];
    await selectRenderedSidebarGrouping("byTime");
    await waitForIsolatedGroupedSection({
      sectionId: "today",
      expectedIds: byTimeIds,
      expectedCount: 10,
      label: "By Time Today initial page",
    });
    await clickGroupedLoadMoreAndWait({
      sectionId: "today",
      expectedIds: byTimeIds,
      previousCount: 10,
      expectedCount: 20,
      label: "By Time Today Load more",
    });

    const byWorkspaceIds = [
      ...fixtureIds(this.sdeFixtures),
      ...fixtureIds(this.managedFixtures),
      ...fixtureIds(this.openCodeFixtures),
    ];
    await selectRenderedSidebarGrouping("byWorkspace");
    await waitForIsolatedGroupedSection({
      sectionId: this.repoPath,
      expectedIds: byWorkspaceIds,
      expectedCount: 10,
      label: "By Workspace initial page",
    });
    await clickGroupedLoadMoreAndWait({
      sectionId: this.repoPath,
      expectedIds: byWorkspaceIds,
      previousCount: 10,
      expectedCount: 20,
      label: "By Workspace Load more",
    });
    await selectRenderedSidebarGrouping("byAgent");
  }

  async verifyRenderedSessionOpening() {
    const sde = newestFixtures(this.sdeFixtures, 1)[0];
    await openRenderedSidebarSession({
      sessionId: sde.sessionId,
      sectionId: SIDEBAR_SECTIONS.sde,
      label: "native SDE session",
      assertNativeReplayBoundary: true,
    });

    const managed = newestFixtures(this.managedFixtures, 1)[0];
    const managedWithTranscript = this.managedFixtures.find(
      (fixture) => fixture.marker
    );
    await openRenderedSidebarSession({
      sessionId: managedWithTranscript?.sessionId ?? managed.sessionId,
      sectionId: SIDEBAR_SECTIONS.managedCli,
      label: "managed OpenCode session",
      marker: managedWithTranscript?.marker,
      expectChatEvents: Boolean(managedWithTranscript?.marker),
    });

    const cursor = this.cursorFixtures[0];
    await openRenderedSidebarSession({
      sessionId: cursor.sessionId,
      sectionId: SIDEBAR_SECTIONS.cursor,
      label: "Cursor App valid conversation",
      marker: cursor.marker,
      expectChatEvents: true,
    });

    const openCode = newestFixtures(this.openCodeFixtures, 1)[0];
    await openRenderedSidebarSession({
      sessionId: openCode.sessionId,
      sectionId: SIDEBAR_SECTIONS.openCode,
      label: "imported OpenCode session",
      marker: openCode.marker,
      expectChatEvents: true,
    });

    const codex = this.codexFixtures.find((fixture) => fixture.largePayload);
    await openRenderedSidebarSession({
      sessionId: codex.sessionId,
      sectionId: SIDEBAR_SECTIONS.codex,
      label: "Codex App large session",
      marker: codex.marker,
      expectChatEvents: true,
    });
  }

  async cleanup() {
    await deleteFixtureSessions(this.cleanupIds);
  }
}
