/**
 * WebSocket Module
 *
 * Real-time session event streaming via WebSocket.
 *
 * Protocol:
 *   1. Connect: ws://server/api/ws?session_id=xxx
 *   2. Receive events for that session (auto-subscribed)
 *
 * Usage:
 *
 *    <WSProvider serverUrl="ws://localhost:8001/api/ws" sessionId={sessionId}>
 *      <App />
 *    </WSProvider>
 *
 *    const { connected } = useWSClient();
 */

// Client
export {
  OrgiiaiWSClient,
  getWSClient,
  initWSClient,
  destroyWSClient,
  WSDebug,
} from "./client";
export type { OrgiiaiWSClientOptions, WSDebugLog } from "./client";

// Provider
export {
  WSProvider,
  useWSClient,
  useWSClientSafe,
  useWSAvailable,
} from "./WSProvider";
export type { WSContextValue, WSProviderProps } from "./WSProvider";

// Types
export type {
  WSEventType,
  WSClientMessageType,
  ActivityChunk,
  QuestionPayload,
  WSMessage,
  WSBaseMessage,
  WSConnectedMessage,
  WSErrorMessage,
  WSPongMessage,
  WSSessionStatusChangedMessage,
  WSSessionCompletedMessage,
  WSSessionFailedMessage,
  WSSessionCancelledMessage,
  WSSessionActivityMessage,
  WSSessionQuestionAskedMessage,
  WSSessionQuestionAnsweredMessage,
  WSAgentEventMessage,
  WSClientMessage,
  WSPingMessage,
} from "./types";
