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
 *   useWorkspaceSession, sessionShowAtom,
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
  ActivityStatus,
  CachedSession,
  EventDisplayStatus,
  EventDisplayVariant,
  ReplayMode,
  ReplayTimeRange,
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
  Snapshot,
  EventStoreProxy,
} from "./core/store";
export { useEventStoreSelector } from "./core/store";

// Replay Atoms
export {
  currentEventAtom,
  currentEventIdAtom,
  currentEventIndexAtom,
  replayBarValueAtom,
  replayModeAtom,
  replayTimeRangeAtom,
  replayTimeRangeValidAtom,
} from "./core/atoms";

// Metadata Atoms
export {
  hasMoreEventsAtom,
  isFromCacheAtom,
  isLoadingMoreAtom,
  lastFetchedAtom,
  loadErrorAtom,
  loadStatusAtom,
  sessionIdAtom,
  sessionReloadEpochMapAtom,
  triggerSessionReloadAtom,
  sessionHydrationCountMapAtom,
  sessionHydrationByIdAtom,
  beginSessionHydrationAtom,
  endSessionHydrationAtom,
  specsAtom,
} from "./core/atoms";
export type { SessionHydrationState } from "./core/atoms";

// Action Atoms
export {
  appendEventsAtom,
  clearSessionAtom,
  clearSessionLoadErrorAtom,
  failSessionLoadAtom,
  goLiveAtom,
  loadSessionAtom,
  navigateNextAtom,
  navigatePrevAtom,
  navigateToEventAtom,
  updateEventAtom,
  updateEventByIdAtom,
  updateEventByPredicateAtom,
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
  currentSimulatorPreviewAtom,
  effectiveSimulatorEventIdsAtom,
  effectiveSimulatorEventsAtom,
  getAppTypeForSimulatorPreview,
  mainReplayCursorMsAtom,
  messagesEventsAtom,
  navigateNextSimulatorEventAtom,
  navigatePrevSimulatorEventAtom,
  navigateToFirstSimulatorEventAtom,
  navigateToLastSimulatorEventAtom,
  navigateToSimulatorEventAtom,
  navigateToSimulatorEventByIndexAtom,
  simulatorEventCountAtom,
  simulatorEventPreviewByIdAtom,
  simulatorEventsAtom,
  simulatorThreadFilteredEventIdsAtom,
  simulatorThreadFilteredEventsAtom,
  sortedSimulatorEventIdsAtom,
  sortedSimulatorEventsAtom,
  threadIdByIdAtom,
} from "./derived/simulatorEvents";

// ============================================
// Ingestion (Normalizers)
// ============================================

// Visibility filters — chat visibility only; simulator/messages visibility
// is computed exclusively in Rust (derived.rs) and consumed via snapshots
export {
  isVisibleInChat,
  stripTerminalCodeBlocks,
} from "./ingestion/visibilityFilters";

// NOTE: normalizeChunk/normalizeChunks are ARCHIVED — use processChunksRust/normalizeChunkRust instead

export {
  normalizeChunkRust,
  processChunksRust,
  setEventStoreRepoContext,
} from "./ingestion/rustBridge";

export {
  type AgentMessageBase,
  type PersistedMessage,
  mergeToolResults,
  parseActivityImages,
  persistedMessageToSessionEvent,
} from "./ingestion/agentMessageAdapters";

// ============================================
// Hooks
// ============================================

// Store hooks (main entry point)
export {
  useCurrentEvent,
  useEventNavigation,
  useReplayBar,
  useSessionStore,
  useSimulatorEvents,
} from "./hooks/useSessionStore";

export type { UseSessionStoreReturn } from "./hooks/useSessionStore";

// Per-session live streaming delta selector (avoids whole-Map subscriptions)
export { useStreamingDeltaForSession } from "./hooks/useStreamingDeltaForSession";

// Session management (hooks/session/) — imported per-file to avoid barrel circularity
export { useSessionManager } from "./hooks/session/useSessionManager";
export { useSessionDiscovery } from "./hooks/session/useSessionDiscovery";
export { useSessionCreator } from "./hooks/session/useSessionCreator";

export type { UseSessionCreatorReturn } from "./hooks/session/useSessionCreator/types";

// Replay & navigation (hooks/replay/)
export {
  useReplayBarState,
  useReplayState,
  useReplayTime,
  useStepState,
  useRecentFiles,
  useRecentFilesForEvent,
  usePlanningIndicator,
} from "./hooks/replay";

export type {
  UseReplayStateReturn,
  WpTimeRange,
  UseStepStateReturn,
  UseRecentFilesReturn,
  PlanningIndicatorState,
} from "./hooks/replay";

// ============================================
// Rendering (tool registry + React-coupled accessors)
// ============================================

// Registry — pure logic only
export { resolveToolName } from "./rendering/registry";

export type {
  ComponentLoader,
  RenderContext,
  RenderMode,
  ChatContextConfig,
  SimulatorContextConfig,
  UnifiedRenderOptions,
} from "./rendering/registry/types";

// Pure data extractors
export { extractTodoData } from "./rendering/props";

// Universal props types
export type {
  UniversalEventProps,
  EventStatus,
  EventVariant,
  AnimationConfig,
} from "./rendering/types/universalProps";

// ============================================
// Storage
// ============================================

// Unified cache adapter
export { cacheAdapter } from "./storage/cacheAdapter";
export type { CacheStats, SearchResult } from "./storage/cacheAdapter";

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
// Use hooks for others: useWorkspaceSession(), useWorkspaceUI(), etc.
export { repoPathAtom, isExploringAtom } from "./workspace/atoms";

// Workspace hooks (replace useSessionContext, useUIContext)
// Note: For chat UI state, use useChatContext from contexts/workspace/ChatContext
export {
  // Session state (replaces useSessionContext)
  useWorkspaceSession,
  useSessionShow,
  useTaskStatus,
  useRepositoryInfo,
  // UI state (replaces useUIContext)
  useWorkspaceUI,
  useCenterTab,
  usePageLoading,
  useActiveView,
} from "./workspace/hooks";

// ============================================
// UI Components — moved to @src/engines/ChatPanel and @src/engines/Simulator
// ============================================
// Shared React UI (blocks, adapters, shared utils, events) lives in
// engines/ChatPanel. Event components are loaded dynamically via
// COMPONENT_LOADERS in SessionCore/rendering/registry/events.

// ============================================
// Registry Types (from EventSystem/registry/)
// ============================================

export type { ComponentOption as RegistryComponentOption } from "./rendering/registry/types";

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
