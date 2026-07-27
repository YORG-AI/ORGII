import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { assertSidebarFixtureRoot } from "./sidebarFixtureIsolation.mjs";

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function writeSqliteDatabase(databasePath, statements) {
  rmSync(databasePath, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
  rmSync(`${databasePath}-wal`, { force: true });
  execFileSync("/usr/bin/sqlite3", [databasePath], {
    encoding: "utf8",
    input: `${statements.join("\n")}\n`,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/**
 * Seed one valid conversation plus the smallest storage pair that used to
 * create a sidebar ghost. The valid row proves real Cursor replay still opens;
 * the shell has only an assistant/tool bubble and must stay non-listable.
 */
export function seedSidebarCursorFixtures(targetHome) {
  assertSidebarFixtureRoot(targetHome);
  const storageDir = join(
    targetHome,
    "Library",
    "Application Support",
    "Cursor",
    "User",
    "globalStorage"
  );
  const statePath = join(storageDir, "state.vscdb");
  const indexPath = join(storageDir, "conversation-search.db");
  const composerId = "e2e-sidebar-stale-cursor-shell";
  const assistantBubbleId = "assistant-tool-shell";
  const validComposerId = "e2e-sidebar-valid-cursor-session";
  const validUserBubbleId = "valid-user";
  const validAssistantBubbleId = "valid-assistant";
  const validTitle = "E2E Sidebar Cursor Architecture Review";
  const validMarker = "E2E Sidebar Cursor rendered response";
  const updatedAt = Date.parse("2026-07-25T13:00:00Z");
  mkdirSync(storageDir, { recursive: true });

  const composer = JSON.stringify({
    composerId,
    name: "Cursor shell must stay hidden",
    createdAt: updatedAt - 1_000,
    lastUpdatedAt: updatedAt,
    status: "completed",
    isAgentic: true,
    unifiedMode: "agent",
    fullConversationHeadersOnly: [{ bubbleId: assistantBubbleId, type: 2 }],
  });
  const assistantBubble = JSON.stringify({
    bubbleId: assistantBubbleId,
    type: 2,
    text: "",
    createdAt: "2026-07-25T13:00:00Z",
    toolFormerData: {
      name: "shell_command",
      rawArgs: '{"command":"pwd"}',
    },
  });
  const validComposer = JSON.stringify({
    composerId: validComposerId,
    name: validTitle,
    createdAt: updatedAt + 60_000,
    lastUpdatedAt: updatedAt + 62_000,
    status: "completed",
    isAgentic: true,
    unifiedMode: "agent",
    fullConversationHeadersOnly: [
      { bubbleId: validUserBubbleId, type: 1 },
      { bubbleId: validAssistantBubbleId, type: 2 },
    ],
  });
  const validUserBubble = JSON.stringify({
    bubbleId: validUserBubbleId,
    type: 1,
    text: validTitle,
    createdAt: "2026-07-25T13:01:00Z",
  });
  const validAssistantBubble = JSON.stringify({
    bubbleId: validAssistantBubbleId,
    type: 2,
    text: validMarker,
    createdAt: "2026-07-25T13:01:01Z",
  });

  writeSqliteDatabase(statePath, [
    "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);",
    `INSERT INTO cursorDiskKV (key, value) VALUES (
      ${sqlLiteral(`composerData:${composerId}`)},
      ${sqlLiteral(composer)}
    );`,
    `INSERT INTO cursorDiskKV (key, value) VALUES (
      ${sqlLiteral(`bubbleId:${composerId}:${assistantBubbleId}`)},
      ${sqlLiteral(assistantBubble)}
    );`,
    `INSERT INTO cursorDiskKV (key, value) VALUES (
      ${sqlLiteral(`composerData:${validComposerId}`)},
      ${sqlLiteral(validComposer)}
    );`,
    `INSERT INTO cursorDiskKV (key, value) VALUES (
      ${sqlLiteral(`bubbleId:${validComposerId}:${validUserBubbleId}`)},
      ${sqlLiteral(validUserBubble)}
    );`,
    `INSERT INTO cursorDiskKV (key, value) VALUES (
      ${sqlLiteral(`bubbleId:${validComposerId}:${validAssistantBubbleId}`)},
      ${sqlLiteral(validAssistantBubble)}
    );`,
  ]);
  writeSqliteDatabase(indexPath, [
    `CREATE TABLE conversations (
      id TEXT,
      title TEXT,
      updated_at INTEGER,
      is_archived INTEGER,
      root_fingerprint TEXT,
      source TEXT
    );`,
    `INSERT INTO conversations VALUES (
      ${sqlLiteral(composerId)},
      ${sqlLiteral("Cursor shell must stay hidden")},
      ${updatedAt},
      0,
      ${sqlLiteral("e2e-stale-shell-v1")},
      ${sqlLiteral("local")}
    );`,
    `INSERT INTO conversations VALUES (
      ${sqlLiteral(validComposerId)},
      ${sqlLiteral(validTitle)},
      ${updatedAt + 62_000},
      0,
      ${sqlLiteral("e2e-valid-cursor-v1")},
      ${sqlLiteral("local")}
    );`,
  ]);

  process.env.E2E_SIDEBAR_CURSOR_GHOST_SESSION_ID = `cursoride-${composerId}`;
  process.env.E2E_SIDEBAR_CURSOR_FIXTURE = JSON.stringify({
    sessionId: `cursoride-${validComposerId}`,
    sourceSessionId: validComposerId,
    title: validTitle,
    marker: validMarker,
    updatedAtMs: updatedAt + 62_000,
  });
}
