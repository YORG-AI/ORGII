import {
  RUST_AGENT_TYPE,
  type RustAgentType,
} from "@src/api/tauri/agent/types";
import {
  IMPORTED_HISTORY_SOURCE_DESCRIPTORS,
  type ImportedHistorySourceId,
} from "@src/api/tauri/externalHistory/imported/descriptors";
import type { DispatchCategory } from "@src/api/tauri/session";

/**
 * Session Dispatch Utilities
 *
 * Centralized detection for session dispatch routing based on session ID prefixes.
 * Use these helpers instead of ad-hoc string checks throughout the codebase.
 *
 * Two orthogonal concepts:
 *
 * 1. Dispatch category (transport/routing):
 *    - "cli_agent": CLI Agent session (external CLI process via Tauri)
 *    - "rust_agent": Rust-native agent session (OS Agent, SDE Agent, Custom)
 *    - "human_session": User-authored proof-of-work session
 *
 * 2. Key source (billing / own key vs hosted key):
 *    - "own_key": User's own API keys (BYOK)
 *    - "hosted_key": Hosted ORGII key (proxied via the marketplace)
 *
 * Key source is stored on the session record, not derived from session ID.
 */

// ============================================
// Session Prefixes Registry
// ============================================

/** Prefix for ORGII-owned, read-only collaboration snapshots. */
export const COLLABORATION_SNAPSHOT_SESSION_PREFIX = "imported-session-";

/**
 * Lifecycle hooks for IDE session types that require a persistent backend
 * watch (e.g. a CDP WebSocket to a running IDE renderer). Both callbacks
 * receive the full `sessionId` (e.g. `cursoride-<uuid>`).
 *
 * Reserved for future live-watch IDE integrations (Trae, Windsurf, etc.).
 * Currently no session type registers a live watch.
 */
export interface SessionLiveWatchHooks {
  /** Start the backend watch for this session. Called once on mount. */
  startWatch: (sessionId: string) => Promise<void>;
  /** Stop the backend watch. Called on unmount (navigation away). */
  stopWatch: (sessionId: string) => Promise<void>;
}

/**
 * Session prefix configuration.
 * When adding a new agent type, add an entry here — all detection functions
 * will automatically recognize it.
 */
export interface SessionPrefixConfig {
  /** The prefix string (e.g., "osagent-") */
  prefix: string;
  /** Session category for adapter resolution */
  category: DispatchCategory;
  /** Agent variant for Rust-native agents; undefined for non-agent sessions */
  variant?: RustAgentType;
  /** Lucide icon slug for UI display */
  iconId: string;
  /** Agent definition ID for built-in agents (e.g., "builtin:os") */
  defId?: string;
  /** Source subtype for imported read-only external history sessions. */
  externalHistorySourceId?: ImportedHistorySourceId;
}

/**
 * Registry of all known session prefixes.
 * Order matters: first match wins for prefix detection.
 */
export const SESSION_PREFIX_REGISTRY: readonly SessionPrefixConfig[] = [
  {
    prefix: "humansession-",
    category: "human_session",
    iconId: "clipboard-list",
  },
  {
    prefix: "osagent-",
    category: "rust_agent",
    variant: RUST_AGENT_TYPE.OS,
    iconId: "omega",
    defId: "builtin:os",
  },
  {
    prefix: "sdeagent-",
    category: "rust_agent",
    variant: RUST_AGENT_TYPE.SDE,
    iconId: "code",
    defId: "builtin:sde",
  },
  {
    prefix: "wingman-",
    category: "rust_agent",
    variant: RUST_AGENT_TYPE.WINGMAN,
    iconId: "hand-metal",
    defId: "builtin:wingman",
  },
  {
    prefix: "agentsession-",
    category: "rust_agent",
    variant: RUST_AGENT_TYPE.SDE,
    iconId: "code",
  },
  {
    prefix: "cliagent-",
    category: "cli_agent",
    variant: undefined,
    iconId: "terminal",
  },
  {
    prefix: COLLABORATION_SNAPSHOT_SESSION_PREFIX,
    category: "external_history",
    variant: undefined,
    iconId: "messages-square",
  },
  ...IMPORTED_HISTORY_SOURCE_DESCRIPTORS.map(
    (source): SessionPrefixConfig => ({
      prefix: source.prefix,
      category:
        source.sourceId === "cursor_ide" ? "cursor_ide" : "external_history",
      variant: undefined,
      iconId: source.iconId,
      externalHistorySourceId: source.sourceId,
    })
  ),
] as const;

// ============================================
// Derived Constants (for backward compatibility)
// ============================================

/** Prefix for OS Agent session IDs */
export const OS_AGENT_SESSION_PREFIX = "osagent-";

/** Prefix for SDE Agent session IDs (Rust-native coding agent) */
export const SDE_AGENT_SESSION_PREFIX = "sdeagent-";

/** Prefix for CLI Agent session IDs */
export const CLI_SESSION_PREFIX = "cliagent-";

/** Prefix for user-authored Human sessions. */
export const HUMAN_SESSION_PREFIX = "humansession-";

/**
 * Prefix for Cursor IDE history session IDs. The bare composer UUID from
 * Cursor's `state.vscdb` is wrapped as `${CURSOR_IDE_SESSION_PREFIX}${uuid}`
 * before crossing into our system; the bounded replay adapter resolves the
 * prefixed ID internally. Frontend code never sees the bare UUID.
 */
export const CURSOR_IDE_SESSION_PREFIX = "cursoride-";

/** Prefix for imported Codex app event session IDs. */
export const CODEX_APP_SESSION_PREFIX = "codexapp-";

/** Prefix for imported Claude Code event session IDs. */
export const CLAUDE_CODE_HISTORY_SESSION_PREFIX = "claudecodeapp-";

/** Prefix for imported OpenCode event session IDs. */
export const OPENCODE_HISTORY_SESSION_PREFIX = "opencodeapp-";

/** Prefix for imported Windsurf event session IDs. */
export const WINDSURF_HISTORY_SESSION_PREFIX = "windsurfapp-";

/** Prefix for imported WorkBuddy event session IDs. */
export const WORKBUDDY_HISTORY_SESSION_PREFIX = "workbuddyapp-";

/** Prefix for imported Warp event session IDs. */
export const WARP_HISTORY_SESSION_PREFIX = "warpapp-";

/** Deterministic local cache ID for a teammate collaboration replay. */
export const COLLAB_IMPORTED_SESSION_PREFIX = "imported-session-";

/** Prefix for Wingman Agent session IDs */
export const WINGMAN_SESSION_PREFIX = "wingman-";

/** Agent definition ID for the built-in OS Agent */
export const BUILTIN_OS_DEF_ID = "builtin:os";

/** Agent definition ID for the built-in ADE Manager (app UI control + dev environment setup) */
export const BUILTIN_ADE_MANAGER_DEF_ID = "builtin:agent-architect";

/** Agent definition ID for the built-in SDE Agent */
export const BUILTIN_SDE_DEF_ID = "builtin:sde";

/** Agent definition ID for the built-in Wingman Agent */
export const BUILTIN_WINGMAN_DEF_ID = "builtin:wingman";

// ============================================
// Internal Helpers
// ============================================

/**
 * Find the matching prefix config for a session ID.
 */
function findPrefixConfig(
  sessionId: string | null | undefined
): SessionPrefixConfig | undefined {
  if (!sessionId) return undefined;
  return SESSION_PREFIX_REGISTRY.find((config) =>
    sessionId.startsWith(config.prefix)
  );
}

// ============================================
// Detection Functions
// ============================================

/**
 * Check if a session ID belongs to a CLI Agent session.
 */
export function isCliSession(sessionId: string | null | undefined): boolean {
  const config = findPrefixConfig(sessionId);
  return config?.category === "cli_agent";
}

/** Check if a session is a user-authored proof-of-work log. */
export function isHumanSession(sessionId: string | null | undefined): boolean {
  return findPrefixConfig(sessionId)?.category === "human_session";
}

/**
 * Check if a session ID belongs to a Cursor IDE history session (read-only).
 */
export function isCursorIdeSession(
  sessionId: string | null | undefined
): boolean {
  const config = findPrefixConfig(sessionId);
  return config?.externalHistorySourceId === "cursor_ide";
}

/**
 * Check if a session ID belongs to imported read-only external history.
 */
export function isExternalHistorySession(
  sessionId: string | null | undefined
): boolean {
  if (
    typeof sessionId === "string" &&
    sessionId.startsWith(COLLABORATION_SNAPSHOT_SESSION_PREFIX)
  ) {
    return isCollaborationSnapshotSession(sessionId);
  }
  const config = findPrefixConfig(sessionId);
  return config?.category === "external_history";
}

export function isImportedHistorySession(
  sessionId: string | null | undefined
): boolean {
  return (
    isCollaborationSnapshotSession(sessionId) ||
    isCursorIdeSession(sessionId) ||
    isExternalHistorySession(sessionId)
  );
}

export function isCollaborationSnapshotSession(
  sessionId: string | null | undefined
): boolean {
  return (
    typeof sessionId === "string" &&
    sessionId.startsWith(COLLABORATION_SNAPSHOT_SESSION_PREFIX) &&
    sessionId.length > COLLABORATION_SNAPSHOT_SESSION_PREFIX.length
  );
}

export function getExternalHistorySourceId(
  sessionId: string | null | undefined
): ImportedHistorySourceId | undefined {
  const config = findPrefixConfig(sessionId);
  return config?.externalHistorySourceId;
}

export function isCodexAppSession(
  sessionId: string | null | undefined
): boolean {
  return getExternalHistorySourceId(sessionId) === "codex_app";
}

export function isClaudeCodeHistorySession(
  sessionId: string | null | undefined
): boolean {
  return getExternalHistorySourceId(sessionId) === "claude_code";
}

export function isOpenCodeHistorySession(
  sessionId: string | null | undefined
): boolean {
  return getExternalHistorySourceId(sessionId) === "opencode";
}

export function isWindsurfHistorySession(
  sessionId: string | null | undefined
): boolean {
  return getExternalHistorySourceId(sessionId) === "windsurf";
}

export function isWorkBuddyHistorySession(
  sessionId: string | null | undefined
): boolean {
  return getExternalHistorySourceId(sessionId) === "workbuddy";
}

export function isWarpHistorySession(
  sessionId: string | null | undefined
): boolean {
  return getExternalHistorySourceId(sessionId) === "warp";
}

/**
 * Check if a session ID belongs to a Wingman agent session.
 */
export function isWingmanSession(
  sessionId: string | null | undefined
): boolean {
  const config = findPrefixConfig(sessionId);
  return config?.variant === RUST_AGENT_TYPE.WINGMAN;
}

/**
 * Check if a session ID belongs to a Rust-native agent session.
 * Matches `osagent-` and `sdeagent-` prefixes (NOT drafts or CLI).
 */
export function isAgentSession(sessionId: string | null | undefined): boolean {
  const config = findPrefixConfig(sessionId);
  return (
    config?.category === "rust_agent" &&
    config?.variant !== undefined &&
    config?.variant !== RUST_AGENT_TYPE.CUSTOM
  );
}

/**
 * Derive the dispatch category from a session ID.
 * Returns the routing category based on ID prefix.
 *
 * Uses the prefix registry for consistent resolution.
 */
export function getDispatchCategory(sessionId: string): DispatchCategory {
  const config = findPrefixConfig(sessionId);
  return config?.category ?? "rust_agent";
}

// ============================================
// Rust Agent Type Resolution
// ============================================

/**
 * Sub-classification within rust_agent sessions.
 * Re-exports `RustAgentType` from the canonical `RUST_AGENT_TYPE` definition.
 */
export type { RustAgentType } from "@src/api/tauri/agent/types";

/**
 * Derive the Rust agent type from a session ID prefix or agent definition ID.
 * Accepts either a `sessionId` string (prefix-based) or a `defId` string (e.g. "builtin:os").
 *
 * Uses the prefix registry for consistent resolution.
 */
export function getRustAgentType(
  sessionIdOrDefId: string | null | undefined
): RustAgentType {
  if (!sessionIdOrDefId) return RUST_AGENT_TYPE.CUSTOM;

  // Check by prefix first
  const config = findPrefixConfig(sessionIdOrDefId);
  if (config?.variant !== undefined) return config.variant;

  // Check by definition ID
  const defIdMatch = SESSION_PREFIX_REGISTRY.find(
    (cfg) => cfg.defId === sessionIdOrDefId
  );
  if (defIdMatch?.variant !== undefined) return defIdMatch.variant;

  return RUST_AGENT_TYPE.CUSTOM;
}

// ============================================
// Icon Resolution
// ============================================

/**
 * Strip the `cursoride-` prefix and return the bare Cursor composer UUID.
 *
 * Returns `null` when the id isn't a Cursor IDE session — use this for
 * defense-in-depth at call sites that already know the session is a
 * `cursoride-*` row (adapter dispatch, dispatcher, pill components).
 */
export function composerIdFromSessionId(sessionId: string): string | null {
  if (!sessionId.startsWith(CURSOR_IDE_SESSION_PREFIX)) return null;
  const tail = sessionId.slice(CURSOR_IDE_SESSION_PREFIX.length);
  return tail.length > 0 ? tail : null;
}

/**
 * Map a session ID to a Lucide icon slug based on its prefix.
 * Pair with `resolveAgentIcon()` from `@src/config/agentIcons` to get the component.
 *
 * Uses the prefix registry — no need to edit this function when adding new agents.
 */
export function resolveSessionIconId(
  sessionId: string | null | undefined
): string {
  if (!sessionId) return "bot";
  // Collaboration replays can open their Chat Pane tab before the local
  // Session row has finished hydrating. Keep that pending tab on the same
  // ORGII mark used by its Team Sessions sidebar row instead of flashing Bot.
  if (sessionId.startsWith(COLLAB_IMPORTED_SESSION_PREFIX)) return "orgii";
  const config = findPrefixConfig(sessionId);
  return config?.iconId ?? "bot";
}

// ============================================
// Session ID Text Extraction
// ============================================

const UUID_PATTERN_SOURCE =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

function escapePatternLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a regex matching full session IDs in free text.
 *
 * Matches `<registered-prefix><uuid>` for every prefix in
 * {@link SESSION_PREFIX_REGISTRY} plus delegate worker handles of the form
 * `agent-<agent_id>-<uuid>` (e.g. `agent-builtin:explore-<uuid>`).
 *
 * Boundary guards ensure we only match standalone tokens: a session ID
 * embedded inside a longer handle (e.g. the parent-session segment of an
 * `extract-mem-<parent>-<uuid>` job ID) is NOT matched.
 *
 * Returned as a factory (fresh regex per call) because `g`-flagged
 * RegExp objects carry mutable `lastIndex` state.
 *
 * Canonical single source for "what does a session id look like in prose" —
 * used by chat reference-card extraction AND by the git-artifact parser to
 * mask session IDs before commit-SHA matching (session UUIDs contain hex
 * segments that otherwise false-positive as commit SHAs).
 */
export function createSessionIdTextPattern(): RegExp {
  const prefixAlternation = SESSION_PREFIX_REGISTRY.map((config) =>
    escapePatternLiteral(config.prefix)
  ).join("|");
  return new RegExp(
    `(?<![\\w:.-])(?:(?:${prefixAlternation})|agent-[A-Za-z0-9:._-]*?-)${UUID_PATTERN_SOURCE}(?![\\w-])`,
    "g"
  );
}

/**
 * Replace every session ID in `text` with same-length whitespace so
 * downstream pattern passes (commit SHAs, file paths) can't partially
 * match inside them. Length-preserving so match indices in the masked
 * text remain valid against the original.
 */
export function maskSessionIdsInText(text: string): string {
  return text.replace(createSessionIdTextPattern(), (match) =>
    " ".repeat(match.length)
  );
}
