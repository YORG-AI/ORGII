/**
 * Defensive sanitization for agent/LLM error messages before they are rendered
 * in {@link AgentErrorChatItem}.
 *
 * The Rust providers already collapse HTML error pages into a concise message,
 * but the frontend must not assume that: a misbehaving upstream (or an older
 * backend build) can still hand us a raw HTML 500 page, a multi-kilobyte body,
 * or a noisy multiline blob. This helper guarantees the panel shows a short,
 * single-purpose, plain-text message regardless of input.
 */

/** Hard cap on the rendered message length (characters). */
const MAX_LENGTH = 600;

/** Standard reason phrases for the statuses LLM upstreams commonly return. */
const REASON_PHRASES: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  408: "Request Timeout",
  409: "Conflict",
  413: "Payload Too Large",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
  529: "Overloaded",
};

const HTML_HINT =
  /<!doctype html|<html[\s>]|<head[\s>]|<body[\s>]|<title[\s>]/i;
const HTTP_STATUS = /\bHTTP\s+(\d{3})\b/i;

/**
 * Codex OAuth refresh tokens rotate after use. A stale/reused refresh token
 * cannot recover through retrying the agent request; the user must reconnect
 * the Codex account instead.
 */
export function requiresCodexReauthentication(raw: string): boolean {
  const message = raw.toLowerCase();
  if (!message) return false;

  const hasCodexContext =
    message.includes("codex oauth") || message.includes("refresh_token_reused");
  const hasReauthenticationSignal =
    message.includes("refresh_token_reused") ||
    message.includes("refresh token has already been used") ||
    message.includes("try signing in again") ||
    message.includes("invalid_grant");

  return hasCodexContext && hasReauthenticationSignal;
}

/**
 * Convert a raw error message into a clean, bounded, single-block string safe
 * for `whitespace-pre-wrap` rendering.
 */
export function sanitizeAgentErrorMessage(raw: string): string {
  if (!raw) return "";

  // Strip a leading "Error:" prefix the same way the previous inline logic did.
  let message = raw.replace(/^\s*Error:\s*/i, "").trim();
  if (!message) return "";

  if (looksLikeHtml(message)) {
    message = summarizeHtmlError(message);
  }

  // Collapse 3+ consecutive blank lines and trailing whitespace so the panel
  // never grows unbounded vertically.
  message = message
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return truncate(message, MAX_LENGTH);
}

function looksLikeHtml(message: string): boolean {
  return HTML_HINT.test(message.slice(0, 512));
}

/**
 * Reduce an HTML-containing error message to `<prefix> HTTP <code> <reason>`.
 * Keeps any human-written lead-in (e.g. "LLM error: Request failed:") that
 * precedes the markup, then replaces the HTML payload with a concise summary.
 */
function summarizeHtmlError(message: string): string {
  const statusMatch = message.match(HTTP_STATUS);
  const status = statusMatch ? Number(statusMatch[1]) : undefined;
  const title = extractTitle(message);

  let summary: string;
  if (status !== undefined && REASON_PHRASES[status] !== undefined) {
    summary = `HTTP ${status} ${REASON_PHRASES[status]}`;
  } else if (status !== undefined && title) {
    summary = `HTTP ${status} ${title}`;
  } else if (status !== undefined) {
    summary = `HTTP ${status}`;
  } else if (title) {
    summary = title;
  } else {
    summary = "Server error";
  }

  // Preserve any leading prose before the HTTP marker / first tag so context
  // like "Request failed:" survives; drop the raw markup that follows.
  const cut = firstHtmlCut(message, statusMatch?.index);
  const prefix = cut > 0 ? message.slice(0, cut).trim() : "";

  return prefix ? `${stripTrailingColon(prefix)}: ${summary}` : summary;
}

/**
 * Index at which to discard the HTML payload: prefer the position of the HTTP
 * status token (so we replace "HTTP 500: <html>" wholesale), otherwise the
 * first angle bracket.
 */
function firstHtmlCut(message: string, statusIndex?: number): number {
  if (statusIndex !== undefined) return statusIndex;
  const tag = message.indexOf("<");
  return tag >= 0 ? tag : 0;
}

function extractTitle(message: string): string | undefined {
  const match = message.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return undefined;
  const title = collapseWhitespace(match[1]);
  return title.length > 0 ? title : undefined;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripTrailingColon(value: string): string {
  return value.replace(/[:\s]+$/, "");
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1).trimEnd()}…`;
}
