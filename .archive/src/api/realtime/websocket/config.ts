/**
 * WebSocket Configuration
 *
 * Configuration constants for WebSocket client.
 * Used by market sessions (port 8001) and Tauri WebSocket (port 13847).
 */

// ============================================
// Server URLs
// ============================================

/**
 * Get WebSocket URL for market sessions.
 * Market uses direct session-specific endpoints.
 */
export function getMarketWSUrl(sessionId: string): string {
  const envUrl =
    process.env.REACT_APP_MARKETPLACE_WS_URL ||
    process.env.VITE_MARKETPLACE_WS_URL;

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";

  // Base URL
  const baseUrl =
    envUrl ||
    (process.env.NODE_ENV === "development"
      ? `${protocol}//localhost:8001`
      : `${protocol}//${window.location.host}`);

  return `${baseUrl}/ws/sessions/${sessionId}`;
}

/**
 * Check if a session is a market session.
 * Market sessions have a listing_id associated with them.
 */
export function isMarketSession(sessionData: {
  listing_id?: string | null;
}): boolean {
  return !!sessionData.listing_id;
}

// ============================================
// Default Options
// ============================================

export const WS_DEFAULT_OPTIONS = {
  /** Ping interval in milliseconds */
  pingInterval: 30000,
  /** Max reconnection attempts */
  maxReconnectAttempts: 5,
  /** Initial reconnection delay in ms */
  initialReconnectDelay: 1000,
  /** Max reconnection delay in ms */
  maxReconnectDelay: 30000,
  /** Enable debug logging in development */
  debug: process.env.NODE_ENV === "development",
} as const;

// ============================================
// Event Type Constants
// ============================================

export const WS_EVENT_TYPES = {
  // Connection
  CONNECTED: "connected",
  DISCONNECTED: "disconnected",
  ERROR: "error",
  SUBSCRIBED: "subscribed",
  UNSUBSCRIBED: "unsubscribed",
  PONG: "pong",

  // Session lifecycle
  SESSION_STATUS_CHANGED: "session.status_changed",
  SESSION_COMPLETED: "session.completed",
  SESSION_FAILED: "session.failed",
  SESSION_CANCELLED: "session.cancelled",

  // Activity
  SESSION_ACTIVITY: "session.activity",

  // Questions
  SESSION_QUESTION_ASKED: "session.question_asked",
  SESSION_QUESTION_ANSWERED: "session.question_answered",

  // Standard session events (from SDK)
  SESSION_PAUSED_USER: "session_paused_user",
  LLM_USAGE: "llm_usage",
  BILLING_PAUSE: "billing_pause",
} as const;

// ============================================
// Stage Names
// ============================================

export {
  SESSION_STAGES,
  type SessionStage,
} from "@src/modules/MainApp/AgentOrgs/data/types";
