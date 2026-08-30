/**
 * Session API Endpoints
 *
 * Combined exports for all session-related endpoints:
 * - local: Own_key session management (create, status, cancel, etc.)
 * - hostedKey: Hosted-key (ORGII key) activity storage and retrieval
 * - unified: Unified API that routes to own_key or hosted_key by context
 */

// My_key session API (main session operations)
export {
  // Session lifecycle
  createSession,
  getSessionStatus,
  cancelSession,
  // Pause/Resume/Interrupt
  pauseSession,
  resumeSession,
  interruptSession,
  // User interaction
  sendMessage,
  sendMessageAndResume,
  answerQuestion,
  // Continue completed session
  continueSession,
  // Stage Approval
  approveStage,
  isWaitingForQuestion,
  // Activity polling
  getActivityChunks,
  // Session discovery
  listSessions,
  listActiveSessions,
  getLastSession,
  cancelAllSessions,
  // Utilities
  isSessionTerminal,
  isSessionActive,
  // Namespace export
  sessionApi,
} from "./local";

// Hosted key activity API (for hosted ORGII sessions)
export {
  getHostedKeyCursor,
  getHostedKeyActivity,
  storeHostedKeyActivityBatch,
  compareStreamIds,
  hostedKeyActivityApi,
  type HostedKeyActivityEvent,
  type HostedKeyCursorData,
  type HostedKeyActivityChunk,
  type HostedKeyActivityListData,
  type HostedKeyActivityBatchRequest,
  type HostedKeyActivityBatchData,
} from "./hostedKey";

// Unified session API (local Rust-backed session API)
export {
  isHostedFromUrl,
  isHostedFromSearchParams,
  createUnifiedSessionApi,
  unifiedSessionApi,
  type UnifiedSessionApi,
} from "./unified";
// Default export - main my_key session API
export { sessionApi as default } from "./local";
