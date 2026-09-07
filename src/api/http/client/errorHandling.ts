/**
 * API Error Handling
 *
 * Error message building and notification display.
 * Uses user-friendly, actionable messages with i18n support.
 */
import { Message } from "@src/components/Message";
import i18n from "@src/i18n";

import {
  NOTIFICATION_DURATION,
  SERVER_ERROR_NOTIFICATION_DURATION,
} from "./config";
import type { ApiErrorResponse, HttpMethod } from "./types";

// ============================================
// Helper Functions
// ============================================

type RequestTitleKey =
  | "githubConnections"
  | "githubConnect"
  | "slackConnections"
  | "workflows"
  | "config"
  | "agent"
  | "repository"
  | "file"
  | "mcp"
  | "extension"
  | "workspace"
  | "wallet"
  | "billing"
  | "default";

/**
 * Get user-friendly title key from URL for error messaging
 */
function getRequestTitleKey(url: string, isAgentApi: boolean): RequestTitleKey {
  const lowerUrl = url.toLowerCase();

  if (lowerUrl.includes("/github/connections")) return "githubConnections";
  if (lowerUrl.includes("/github/connect")) return "githubConnect";
  if (
    lowerUrl.includes("/slack/connections") ||
    lowerUrl.includes("/slack/connect")
  )
    return "slackConnections";
  if (
    lowerUrl.includes("/billing/balance") ||
    lowerUrl.includes("/billing/transactions") ||
    lowerUrl.includes("/billing/add-funds")
  )
    return "wallet";
  if (lowerUrl.includes("/billing/")) return "billing";
  if (lowerUrl.includes("/mcp/config") || lowerUrl.includes("/mcp/"))
    return "mcp";
  if (lowerUrl.includes("/workflows")) return "workflows";
  if (lowerUrl.includes("/extension") || lowerUrl.includes("/bridge"))
    return "extension";
  if (lowerUrl.includes("/agent") || isAgentApi) return "agent";
  if (lowerUrl.includes("/config")) return "config";
  if (lowerUrl.includes("/project") || lowerUrl.includes("/workspace"))
    return "workspace";
  if (lowerUrl.includes("/repository") || lowerUrl.includes("/repo"))
    return "repository";
  if (lowerUrl.includes("/file")) return "file";

  return "default";
}

/**
 * Capitalize first letter of a string
 */
export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

type MessageKey =
  | "network"
  | "timeout"
  | "server"
  | "notFound"
  | "signIn"
  | "forbidden"
  | "tooManyRequests"
  | "validation"
  | "conflict"
  | "badGateway"
  | "serviceUnavailable"
  | "gatewayTimeout"
  | "invalidRequest"
  | "default";

/**
 * Get user-friendly message key from status code
 */
function getMessageKey(status: number | undefined): MessageKey {
  if (!status) return "network";
  switch (status) {
    case 400:
      return "invalidRequest";
    case 401:
      return "signIn";
    case 403:
      return "forbidden";
    case 404:
      return "notFound";
    case 408:
      return "timeout";
    case 409:
      return "conflict";
    case 422:
      return "validation";
    case 429:
      return "tooManyRequests";
    case 502:
      return "badGateway";
    case 503:
      return "serviceUnavailable";
    case 504:
      return "gatewayTimeout";
    default:
      return status >= 500 ? "server" : "default";
  }
}

/**
 * Build user-friendly error message from error response
 */
export function buildErrorMessage(
  error: ApiErrorResponse,
  _method: HttpMethod,
  _url: string
): string {
  const status = error.response?.status;
  const detail = error.response?.data?.detail;

  // Use server-provided detail if available and user-friendly
  if (detail && typeof detail === "string" && detail.length < 200) {
    return detail;
  }

  const key = getMessageKey(status);
  return i18n.t(`errors.api.messages.${key}`);
}

// ============================================
// Notification Functions
// ============================================

/**
 * Show user-friendly error notification (no endpoint shown)
 */
export function showErrorNotification(
  url: string,
  errorMessage: string,
  _method: HttpMethod,
  isAgentApi: boolean = false
): void {
  const titleKey = getRequestTitleKey(url, isAgentApi);
  const title = i18n.t(`errors.api.titles.${titleKey}`);

  Message.error({
    title,
    content: errorMessage,
    duration: NOTIFICATION_DURATION,
  });
}

/**
 * Show workflow-specific error notification
 */
export function showWorkflowErrorNotification(): void {
  Message.error({
    title: i18n.t("errors.api.titles.workflows"),
    content: i18n.t("errors.api.workflow"),
    duration: 10000,
  });
}

/**
 * Show timeout error notification
 */
export function showTimeoutErrorNotification(): void {
  Message.error({
    title: i18n.t("errors.api.titles.timeout"),
    content: i18n.t("errors.api.messages.timeout"),
    duration: NOTIFICATION_DURATION,
  });
}

/**
 * Show server error (500) notification
 */
export function showServerErrorNotification(
  url: string,
  _method: HttpMethod,
  isAgentApi: boolean = false
): void {
  const titleKey = getRequestTitleKey(url, isAgentApi);
  const title = i18n.t(`errors.api.titles.${titleKey}`);

  Message.error({
    title,
    content: i18n.t("errors.api.messages.server"),
    duration: SERVER_ERROR_NOTIFICATION_DURATION,
  });
}

/**
 * Show API response error notification
 */
export function showResponseErrorNotification(
  title?: string,
  message?: string,
  duration?: number
): void {
  Message.error({
    title,
    content: message || "",
    duration,
  });
}
