/**
 * Session Agent Groups
 *
 * Per-agent-type groupings for session sidebar display.
 * Splits Rust agents into OS / SDE / Wingman sections and imported history
 * sources into provider-specific sections.
 */
import {
  RUST_AGENT_TYPE,
  type RustAgentType,
} from "@src/api/tauri/agent/types";
import {
  IMPORTED_HISTORY_SOURCES,
  type ImportedHistoryListCategory,
  getImportedHistorySourceBySessionId,
} from "@src/api/tauri/importedHistory";
import {
  getRustAgentType,
  isCliSession,
  isCursorIdeSession,
} from "@src/util/session/sessionDispatch";

export type SessionGroupKey =
  | RustAgentType
  | "cli"
  | "cursor_ide"
  | ImportedHistoryListCategory;

export function getSessionGroupKey(sessionId: string): SessionGroupKey {
  if (isCursorIdeSession(sessionId)) return "cursor_ide";
  const importedSource = getImportedHistorySourceBySessionId(sessionId);
  if (importedSource) return importedSource.listCategory;
  if (isCliSession(sessionId)) return "cli";
  return getRustAgentType(sessionId);
}

export const SESSION_GROUP_ORDER: readonly SessionGroupKey[] = [
  RUST_AGENT_TYPE.OS,
  RUST_AGENT_TYPE.SDE,
  RUST_AGENT_TYPE.WINGMAN,
  "cli",
  "cursor_ide",
  ...IMPORTED_HISTORY_SOURCES.map((source) => source.listCategory),
];

const IMPORTED_HISTORY_LABELS: Record<ImportedHistoryListCategory, string> =
  Object.fromEntries(
    IMPORTED_HISTORY_SOURCES.map((source) => [
      source.listCategory,
      source.groupLabel,
    ])
  ) as Record<ImportedHistoryListCategory, string>;

export const SESSION_GROUP_LABELS: Record<SessionGroupKey, string> = {
  [RUST_AGENT_TYPE.OS]: "OS Agent",
  [RUST_AGENT_TYPE.SDE]: "SDE Agent",
  [RUST_AGENT_TYPE.WINGMAN]: "Wingman Agent",
  [RUST_AGENT_TYPE.CUSTOM]: "Custom Agent",
  cli: "CLI Agent",
  cursor_ide: "Cursor History",
  ...IMPORTED_HISTORY_LABELS,
};

/** Display labels for channel-originated sessions (keyed by channel name from backend). */
export const CHANNEL_LABELS: Record<string, string> = {
  feishu: "Feishu / Lark",
  telegram: "Telegram",
  discord: "Discord",
  email: "Email",
};
