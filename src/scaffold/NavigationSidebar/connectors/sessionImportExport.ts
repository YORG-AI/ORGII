import type { TFunction } from "i18next";
import { z } from "zod/v4";

import {
  type ExternalReplayOrgiiEnvelope,
  type ExternalReplayTarget,
  externalReplayQueryWindowForTarget,
  resolveExternalReplayTarget,
  resolveSecondaryReplayTarget,
} from "@src/api/tauri/externalHistory/replay";
import type { DispatchCategory } from "@src/api/tauri/session";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { cacheAdapter } from "@src/engines/SessionCore/storage/cacheAdapter";
import { loadOwnSessionInitialEvents } from "@src/engines/SessionCore/sync/sessionSyncUtils";
import { createLogger } from "@src/hooks/logger";
import type { Session } from "@src/store/session";
import { sessionsAtom, upsertSession } from "@src/store/session";
import { persistSessions } from "@src/store/session/sessionAtom/persistence";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";
import {
  isAgentSession,
  isCliSession,
  isCursorIdeSession,
} from "@src/util/session/sessionDispatch";
import { getSessionListDisplayName } from "@src/util/session/sessionSidebarRow";

const logger = createLogger("SessionImportExport");

const EXPORT_FORMAT = "orgii.session.export";
const EXPORT_VERSION = 1;
const IMPORTED_SESSION_PREFIX = "imported-session-";
const SNAPSHOT_ICON_ID = "archive";
const SNAPSHOT_MODEL = "Imported JSON Snapshot";
const FILENAME_UNSAFE_CHARS = /[/\\?%*:|"<>]/g;

const ImportedSessionMetadataSchema = z.object({
  originalSessionId: z.string(),
  originalCategory: z.enum(["cli_agent", "rust_agent", "cursor_ide"]),
  exportedAt: z.string(),
  eventCount: z.number(),
});

const SessionExportFileSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  version: z.literal(EXPORT_VERSION),
  exportedAt: z.string(),
  session: z.object({
    session_id: z.string(),
    status: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
    completed_at: z.string().optional(),
    user_input: z.string().optional(),
    repo_name: z.string().optional(),
    name: z.string().optional(),
    branch: z.string().optional(),
    category: z.enum(["cli_agent", "rust_agent", "cursor_ide"]).optional(),
    cliAgentType: z.string().optional(),
    model: z.string().optional(),
    repoPath: z.string().optional(),
    worktreePath: z.string().optional(),
    worktreeBranch: z.string().optional(),
    baseBranch: z.string().optional(),
    background: z.boolean().optional(),
    workItemId: z.string().optional(),
    agentRole: z.string().optional(),
    agentDefinitionId: z.string().optional(),
    agentIconId: z.string().optional(),
    agentDisplayName: z.string().optional(),
    agentExecMode: z.string().optional(),
    pinned: z.boolean().optional(),
    created_time: z.string().optional(),
    updated_time: z.string().optional(),
  }),
  metadata: z.object({
    originalCategory: z.enum(["cli_agent", "rust_agent", "cursor_ide"]),
    eventCount: z.number(),
  }),
  payload: z.object({
    events: z.array(z.record(z.string(), z.unknown())),
    specs: z.array(z.unknown()).optional(),
    timeRange: z
      .object({
        start: z.string(),
        end: z.string(),
      })
      .optional(),
  }),
});

export type SessionExportFile = z.output<typeof SessionExportFileSchema>;

export interface SessionExportPreview {
  sessionId: string;
  displayName: string;
  category: DispatchCategory;
  eventCount: number;
  fileName: string;
  exportedAt: string;
}

export interface MaterializedSessionExportDraft {
  mode: "materialized";
  file: SessionExportFile;
  preview: SessionExportPreview;
}

export interface BoundedReplaySessionExportDraft {
  mode: "bounded-replay";
  sessionId: string;
  replayTarget: ExternalReplayTarget;
  orgiiEnvelope: ExternalReplayOrgiiEnvelope;
  preview: SessionExportPreview;
}

export type SessionExportDraft =
  | MaterializedSessionExportDraft
  | BoundedReplaySessionExportDraft;

export interface SessionImportPreview {
  originalSessionId: string;
  displayName: string;
  originalCategory: DispatchCategory;
  eventCount: number;
  exportedAt: string;
  importSessionId: string;
  importedName: string;
}

export interface SessionImportResult extends SessionImportPreview {
  importedEventCount: number;
}

type ExportableCategory = "cli_agent" | "rust_agent" | "cursor_ide";

function inferCategory(
  sessionId: string,
  explicit?: DispatchCategory
): ExportableCategory {
  if (
    explicit === "cli_agent" ||
    explicit === "rust_agent" ||
    explicit === "cursor_ide"
  )
    return explicit;
  if (explicit === "external_history") {
    return isCursorIdeSession(sessionId) ? "cursor_ide" : "cli_agent";
  }
  if (isCursorIdeSession(sessionId)) return "cursor_ide";
  if (isCliSession(sessionId)) return "cli_agent";
  return "rust_agent";
}

function sanitizeFileName(value: string): string {
  const sanitized = value.replace(FILENAME_UNSAFE_CHARS, "-").trim();
  return (sanitized || "session").slice(0, 60);
}

function buildExportFileName(session: Session, fallback: string): string {
  const displayName = getSessionListDisplayName(session, fallback);
  return `${sanitizeFileName(displayName)}.orgii-session.json`;
}

function buildImportedSessionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `${IMPORTED_SESSION_PREFIX}${crypto.randomUUID()}`;
  }
  return `${IMPORTED_SESSION_PREFIX}${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function parseEventDate(value: string | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function getTimeRange(events: SessionEvent[], session: Session) {
  const eventTimes = events
    .map((event) => parseEventDate(event.createdAt))
    .filter((timestamp): timestamp is number => timestamp !== null);
  const start = eventTimes.length
    ? new Date(Math.min(...eventTimes)).toISOString()
    : session.created_at;
  const end = eventTimes.length
    ? new Date(Math.max(...eventTimes)).toISOString()
    : session.updated_at;
  return { start, end };
}

function metadataFromSession(
  session: Session,
  eventCount: number,
  exportedAt: string
) {
  return {
    originalSessionId: session.session_id,
    originalCategory: inferCategory(session.session_id, session.category),
    exportedAt,
    eventCount,
  } satisfies z.output<typeof ImportedSessionMetadataSchema>;
}

function cloneSessionForExport(session: Session): SessionExportFile["session"] {
  return {
    session_id: session.session_id,
    status: String(session.status),
    created_at: session.created_at,
    updated_at: session.updated_at,
    completed_at: session.completed_at,
    user_input: session.user_input,
    repo_name: session.repo_name,
    name: session.name,
    branch: session.branch,
    category: inferCategory(session.session_id, session.category),
    cliAgentType: session.cliAgentType,
    model: session.model,
    repoPath: session.repoPath,
    worktreePath: session.worktreePath,
    worktreeBranch: session.worktreeBranch,
    baseBranch: session.baseBranch,
    background: session.background,
    workItemId: session.workItemId,
    agentRole: session.agentRole,
    agentDefinitionId: session.agentDefinitionId,
    agentIconId: session.agentIconId,
    agentDisplayName: session.agentDisplayName,
    agentExecMode: session.agentExecMode,
    pinned: session.pinned,
    created_time: session.created_time,
    updated_time: session.updated_time,
  };
}

function remapEventToImportedSession(
  event: SessionEvent,
  importSessionId: string,
  index: number
): SessionEvent {
  const originalId = event.id || `event-${index}`;
  return {
    ...event,
    id: `${importSessionId}:${originalId}`,
    sessionId: importSessionId,
    processId: event.processId
      ? `${importSessionId}:${event.processId}`
      : undefined,
  };
}

async function loadSessionEventsForExport(
  session: Session
): Promise<SessionEvent[]> {
  const sessionId = session.session_id;
  if (isAgentSession(sessionId)) {
    return loadOwnSessionInitialEvents(sessionId);
  }

  const fullSession = await cacheAdapter.loadFullSession(sessionId);
  if (fullSession) return fullSession.events;
  return cacheAdapter.loadEvents(sessionId);
}

export async function buildSessionExportDraft(
  session: Session,
  fallback: string
): Promise<SessionExportDraft> {
  const exportedAt = new Date().toISOString();
  const category = inferCategory(session.session_id, session.category);
  const fileName = buildExportFileName(session, fallback);
  const previewBase = {
    sessionId: session.session_id,
    displayName: getSessionListDisplayName(session, fallback),
    category,
    fileName,
    exportedAt,
  };

  const primaryReplayTarget = resolveExternalReplayTarget(session.session_id);
  const replayTarget =
    primaryReplayTarget ??
    (await resolveSecondaryReplayTarget(session.session_id));
  if (replayTarget) {
    // Export preview reads only the compact index plus at most one event. The
    // confirmation path streams the compatible envelope in Rust and never
    // builds the transcript or the final JSON string in the renderer.
    const window = await externalReplayQueryWindowForTarget({
      target: replayTarget,
      limits: {
        maxTurns: 1,
        maxEvents: 1,
        maxIpcBytes: 128 * 1024,
      },
    });
    return {
      mode: "bounded-replay",
      sessionId: session.session_id,
      replayTarget,
      orgiiEnvelope: {
        exportedAt,
        session: cloneSessionForExport(session),
        originalCategory: category,
        specs: [],
      },
      preview: {
        ...previewBase,
        eventCount: window.totalEventCount,
      },
    };
  }

  const events = await loadSessionEventsForExport(session);
  const file: SessionExportFile = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt,
    session: cloneSessionForExport(session),
    metadata: {
      originalCategory: category,
      eventCount: events.length,
    },
    payload: {
      events: events as unknown as Record<string, unknown>[],
      specs: [],
      timeRange: getTimeRange(events, session),
    },
  };
  return {
    mode: "materialized",
    file,
    preview: {
      ...previewBase,
      eventCount: events.length,
    },
  };
}

export async function buildSessionExportPreview(
  session: Session,
  fallback: string
): Promise<SessionExportPreview> {
  const draft = await buildSessionExportDraft(session, fallback);
  return draft.preview;
}

export async function buildSessionExportFile(
  session: Session,
  fallback: string
): Promise<SessionExportFile> {
  const draft = await buildSessionExportDraft(session, fallback);
  if (draft.mode === "bounded-replay") {
    throw new Error(
      "External session exports must be streamed to a destination path"
    );
  }
  return draft.file;
}

export function parseSessionImportFile(
  rawJson: string,
  t: TFunction<"sessions">
): { parsed: SessionExportFile; preview: SessionImportPreview } {
  let raw: unknown;
  try {
    raw = JSON.parse(rawJson) as unknown;
  } catch (error) {
    logger.error("failed to parse session export JSON:", error);
    throw new Error(t("chat.importExport.errors.invalidJson"));
  }

  const parsed = SessionExportFileSchema.parse(raw);
  const importSessionId = buildImportedSessionId();
  const displayName =
    parsed.session.name ||
    parsed.session.user_input ||
    parsed.session.session_id;
  const importedName = t("chat.importExport.importedName", {
    name: displayName,
  });
  return {
    parsed,
    preview: {
      originalSessionId: parsed.session.session_id,
      displayName,
      originalCategory: parsed.metadata.originalCategory,
      eventCount: parsed.metadata.eventCount,
      exportedAt: parsed.exportedAt,
      importSessionId,
      importedName,
    },
  };
}

export async function importSessionExportFile(
  parsed: SessionExportFile,
  preview: SessionImportPreview
): Promise<SessionImportResult> {
  const events = parsed.payload.events as unknown as SessionEvent[];
  const remappedEvents = events.map((event, index) =>
    remapEventToImportedSession(event, preview.importSessionId, index)
  );
  const now = new Date().toISOString();
  const timeRange = parsed.payload.timeRange ?? {
    start: parsed.session.created_at,
    end: parsed.session.updated_at,
  };
  await cacheAdapter.saveFullSession(
    preview.importSessionId,
    remappedEvents,
    [],
    timeRange
  );

  const importMetadata = metadataFromSession(
    parsed.session as Session,
    remappedEvents.length,
    parsed.exportedAt
  );
  const importedSession: Session = {
    session_id: preview.importSessionId,
    status: "completed",
    created_at: parsed.session.created_at || now,
    updated_at: now,
    created_time:
      parsed.session.created_time || parsed.session.created_at || now,
    updated_time: now,
    user_input: parsed.session.user_input,
    repo_name: parsed.session.repo_name,
    name: preview.importedName,
    branch: parsed.session.branch,
    category: "rust_agent",
    model: SNAPSHOT_MODEL,
    repoPath: parsed.session.repoPath,
    worktreePath: parsed.session.worktreePath,
    worktreeBranch: parsed.session.worktreeBranch,
    baseBranch: parsed.session.baseBranch,
    background: false,
    agentIconId: SNAPSHOT_ICON_ID,
    agentDisplayName: SNAPSHOT_MODEL,
    pinned: false,
    error_message: JSON.stringify(importMetadata),
  };
  upsertSession(importedSession);
  persistSessions(getInstrumentedStore().get(sessionsAtom));
  return { ...preview, importedEventCount: remappedEvents.length };
}

export function formatCategoryLabel(
  category: DispatchCategory,
  t: TFunction<"sessions">
): string {
  switch (category) {
    case "cli_agent":
      return t("chat.importExport.categories.cli");
    case "rust_agent":
      return t("chat.importExport.categories.rust");
    case "cursor_ide":
      return t("chat.importExport.categories.cursorIde");
    case "external_history":
      return t("chat.importExport.categories.externalHistory");
  }
}

export function formatEventCount(
  count: number,
  t: TFunction<"sessions">
): string {
  return t("chat.eventCount", { count });
}

export function stringifySessionExportFile(payload: SessionExportFile): string {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export const SESSION_JSON_FILTER = {
  name: "ORGII Session JSON",
  extensions: ["json"],
};
