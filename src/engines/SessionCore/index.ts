/**
 * Session Module
 *
 * Unified state management, UI components, and workspace state for sessions.
 * Single source of truth for ChatPanel, Simulator, and all event-related features.
 *
 * ## Architecture (after Option F consolidation)
 *
 * ```
 * session/
 * ├── core/       - State atoms (eventsAtom, replayAtom, etc.)
 * ├── derived/    - Derived atoms (chatEventsAtom, simulatorEventsAtom)
 * ├── hooks/      - Business logic hooks
 * ├── rendering/  - Event rendering infrastructure + registry
 * ├── workspace/  - Workspace-scoped state (from contexts/workspace/)
 * ├── ui/         - Event UI components (from Events/, EventBlocks/)
 * └── storage/    - Persistence (IndexedDB, sessionStorage)
 * ```
 *
 * ## Usage
 *
 * ```tsx
 * import {
 *   // State
 *   eventsAtom, currentEventAtom,
 *   // Workspace state
 *   useRepositoryInfo, sessionShowAtom,
 *   // UI components
 *   ShellEvent, TerminalBlock,
 *   // Adapters
 * } from '@src/engines/SessionCore';
 * ```
 *
 * ## Initialization
 *
 * Call `initSessionCore()` at app startup to initialize adapters and EventStore.
 */
import { eventStoreProxy } from "./core/store";

/**
 * Initialize SessionCore subsystems.
 * Call once at app startup (e.g., in App.tsx or main.tsx).
 *
 * Returns a Promise that resolves once the Tauri `es:changed` listener is
 * registered, so callers can await before mounting session-dependent components.
 * Both operations are idempotent — safe to call multiple times.
 */
export async function initSessionCore(): Promise<void> {
  await eventStoreProxy.init();
}

// ============================================
// Types
// ============================================

export type {
  EventDisplayVariant,
  ReplayMode,
  SessionEvent,
  SessionLoadStatus,
  SessionSpec,
  SimulatorEventPreview,
} from "./core/types";

// ============================================
// Core Atoms
// ============================================

export {
  editTruncationTimestampAtom,
  eventCountAtom,
  eventIndexAtom,
  eventsAtom,
  eventStoreVersionAtom,
  sortedEventsAtom,
  streamingDeltaContentAtom,
} from "./core/atoms";

// Event Store (Rust-backed proxy)
export { eventStore, eventStoreProxy } from "./core/store";
export type {
  DerivedSnapshot,
  StreamingSnapshot,
  EventStoreProxy,
} from "./core/store";
export { useEventStoreSelector } from "./core/store";

// Replay Atoms
export {
  currentEventAtom,
  currentEventIdAtom,
  replayBarValueAtom,
  replayModeAtom,
  replayTimeRangeAtom,
} from "./core/atoms";

// Metadata Atoms
export {
  loadErrorAtom,
  loadStatusAtom,
  sessionIdAtom,
  sessionReloadEpochMapAtom,
  triggerSessionReloadAtom,
  sessionHydrationByIdAtom,
  beginSessionHydrationAtom,
  endSessionHydrationAtom,
  specsAtom,
} from "./core/atoms";

// Action Atoms
export {
  clearSessionAtom,
  clearSessionLoadErrorAtom,
  failSessionLoadAtom,
  loadSessionAtom,
  updateEventByIdAtom,
} from "./core/atoms";

// Note: Context-aware atoms (effectiveEventsAtom, threadFilteredEventsAtom, etc.)
// are internal implementation details. Use derived atoms or hooks instead.

// ============================================
// Derived Atoms
// ============================================

export {
  SIMULATOR_EVENT_FILTER_VALUES,
  isSimulatorEventVisibleForFilters,
  type SimulatorEventFilterValue,
} from "./derived/simulatorEventFilters";
export { chatEventsAtom } from "./derived/chatEvents";
export {
  createdAtByIdAtom,
  currentSimulatorEventIndexAtom,
  effectiveSimulatorEventIdsAtom,
  getAppTypeForSimulatorPreview,
  mainReplayCursorMsAtom,
  messagesEventsAtom,
  navigateNextSimulatorEventAtom,
  navigatePrevSimulatorEventAtom,
  navigateToFirstSimulatorEventAtom,
  navigateToSimulatorEventByIndexAtom,
  simulatorEventCountAtom,
  simulatorEventPreviewByIdAtom,
  sortedSimulatorEventIdsAtom,
} from "./derived/simulatorEvents";

// ============================================
// Ingestion (Normalizers)
// ============================================

// Visibility filters — chat visibility only; simulator/messages visibility
// is computed exclusively in Rust (derived.rs) and consumed via snapshots
export { isVisibleInChat } from "./ingestion/visibilityFilters";

// NOTE: normalizeChunk/normalizeChunks are ARCHIVED — use processChunksRust/normalizeChunkRust instead

export { processChunksRust } from "./ingestion/rustBridge";

export {
  mergeToolResults,
  parseActivityImages,
  persistedMessageToSessionEvent,
} from "./ingestion/agentMessageAdapters";

// ============================================
// Hooks
// ============================================

// Store hooks (main entry point)
export { useEventNavigation } from "./hooks/useEventNavigation";

// Per-session live streaming delta selector (avoids whole-Map subscriptions)
export { useStreamingDeltaForSession } from "./hooks/useStreamingDeltaForSession";
export { useCanvasRevisionDraftForSession } from "./hooks/useCanvasRevisionDraftForSession";

// Session management (hooks/session/) — imported per-file to avoid barrel circularity
export { useSessionDiscovery } from "./hooks/session/useSessionDiscovery";
export { useSessionCreator } from "./hooks/session/useSessionCreator";

// Replay & navigation (hooks/replay/)
export { useStepState, usePlanningIndicator } from "./hooks/replay";

// ============================================
// Rendering (tool registry + React-coupled accessors)
// ============================================

// Registry — pure logic only
export { resolveToolName } from "./rendering/registry";

// Pure data extractors
export { extractTodoData } from "./rendering/props";

// Universal props types
export type { EventStatus } from "./rendering/types/universalProps";

// ============================================
// Storage
// ============================================

// Unified cache adapter
export { cacheAdapter } from "./storage/cacheAdapter";

// Individual backends
export { sqliteCache } from "./storage/sqliteCache";

// ============================================
// Legacy Compatibility - REMOVED
// Converters have been inlined into their usage sites
// ============================================

// ============================================
// Workspace State (from contexts/workspace/)
// ============================================

// Workspace atoms - Only externally-used atoms are exported
// Use focused workspace hooks for other state.
export { isExploringAtom } from "./workspace/atoms";

// Workspace hooks (replace useSessionContext, useUIContext)
// Note: For chat UI state, use useChatContext from contexts/workspace/ChatContext
export { useRepositoryInfo } from "./workspace/hooks";

// ============================================
// Session Service (singleton operations API)
// ============================================
// NOTE: SessionService and PlanExecutionService are NOT re-exported here
// to avoid pulling the entire SessionCore barrel into the services layer
// (which causes webpack module-init ordering issues).
//
// Import directly:
//   import { SessionService } from "@src/engines/SessionCore/services/SessionService";
//   import { PlanExecutionService } from "@src/engines/SessionCore/services/PlanExecutionService";
// Or via the sub-barrel:
//   import { SessionService } from "@src/engines/SessionCore/services";
