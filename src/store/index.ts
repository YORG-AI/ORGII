/**
 * Store - Main Barrel Export
 *
 * Central export point for all atoms.
 *
 * Structure:
 * - settings/    - VS Code-style settings JSONC (~/.orgii/settings.jsonc)
 * - session/     - Session state, file sync, CLI runtime, file review, shell processes
 * - repo/        - Repository state
 * - project/     - Orgii projects, multi-repo, sync, tracker mode
 * - user/        - Current user entity
 * - search/      - Code search indexing across repos
 * - git/         - Git status and operations
 * - config/      - App config atoms (chat UI, IDE bridge)
 * - agent/       - OS agent + AI control panel
 * - platform/  - Dev mode, system dependency scan
 * - ui/          - UI state
 * - workstation/  - Workstation tab, code-editor, and browser state
 */

// Session atoms (events, replay, session state)
// NOTE: Direct imports to avoid circular dependency through the barrel
export type {
  SessionEvent,
  SessionLoadStatus,
  ReplayMode,
  ReplayTimeRange,
  EventDisplayVariant,
  EventDisplayStatus,
  ActivityStatus,
  CachedSession,
  SessionSpec,
} from "@src/engines/SessionCore/core/types";

export {
  useSessionStore,
  useCurrentEvent,
  useEventNavigation,
  useReplayBar,
  useSimulatorEvents,
} from "@src/engines/SessionCore/hooks/useSessionStore";

export {
  isVisibleInChat,
  stripTerminalCodeBlocks,
} from "@src/engines/SessionCore/ingestion/visibilityFilters";

// NOTE: normalizeChunk/normalizeChunks are ARCHIVED
// Use processChunksRust/normalizeChunkRust from "@src/engines/SessionCore/ingestion/rustBridge" instead

// Settings (VS Code-style JSONC file, ~/.orgii/settings.jsonc)
export * from "./settings";

// Session state (local, cloud, view, creator)
export * from "./session";

// Repository state
export * from "./repo";

// Orgii projects, branch sync, tracker
export * from "./project";

// Current user
export * from "./user";

// Code search / indexing
export * from "./search";

// Git (status, operations)
export * from "./git";

// App configuration (distinct from settings JSONC where needed)
export * from "./config";

// Platform (dev mode, system deps)
export * from "./platform";

// UI atoms (pure UI state)
export * from "./ui";

// Workstation atoms (code-editor, database, browser)
export * from "./workstation";
