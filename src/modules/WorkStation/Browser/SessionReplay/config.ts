/**
 * Browser Session Replay Configuration
 *
 * Defines state derivation logic for the browser simulator.
 * Event matching uses Rust registry (getAppTypeForTool) as single source of truth.
 *
 * Supports two subtools:
 * - browser: External browser (Playwright/CDP, Chrome) — screenshot display
 * - internal_browser: Internal browser (Tauri inline webview DOM automation)
 */
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { getAppSubtool } from "@src/engines/SessionCore/rendering/registry/initToolRegistry";
import { defineSimulatorAppConfig } from "@src/engines/Simulator/apps/core/configFactory";
import "@src/engines/Simulator/apps/core/matchers";
import { AppType } from "@src/engines/Simulator/types/appTypes";
import {
  getToolDisplayLabelFromRegistry,
  getToolTitleFromRegistry,
} from "@src/util/ui/rendering/registryToolLabel";
import {
  deriveToolAction,
  formatBrowserCliCommandTarget,
} from "@src/util/ui/rendering/toolAction";

import type {
  BrowserEntry,
  InternalBrowserAction,
  InternalBrowserEntry,
  SimulatorBrowserState,
} from "./types";

function getTitleFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function getEventArgs(event: SessionEvent): Record<string, unknown> {
  return event.args &&
    typeof event.args === "object" &&
    !Array.isArray(event.args)
    ? (event.args as Record<string, unknown>)
    : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trimStart();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function getRecordField(
  record: Record<string, unknown> | null | undefined,
  key: string
): Record<string, unknown> | null {
  const value = record?.[key];
  return isRecord(value) ? value : null;
}

function getStringField(
  record: Record<string, unknown> | null | undefined,
  key: string
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function getBooleanField(
  record: Record<string, unknown> | null | undefined,
  key: string
): boolean | undefined {
  const value = record?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function extractToolResultObject(event: SessionEvent): Record<string, unknown> {
  const parsedDirect = parseJsonRecord(event.result);
  if (parsedDirect) return parsedDirect;

  const direct = isRecord(event.result) ? event.result : {};
  for (const field of ["output", "content", "observation"] as const) {
    const parsed = parseJsonRecord(direct[field]);
    if (parsed) return parsed;
  }
  return direct;
}

function getBrowserEntrySubtitle(
  event: SessionEvent,
  args: Record<string, unknown>
): string | undefined {
  const action = deriveToolAction(event.functionName, args);
  const command = args.command;
  if (typeof command === "string" && command.trim().length > 0) {
    return action ? formatBrowserCliCommandTarget(action, command) : command;
  }

  const url =
    (args.url as string | undefined) ||
    (args.targetUrl as string | undefined) ||
    (args.uri as string | undefined) ||
    (args.address as string | undefined);
  if (url) return url;

  return action || undefined;
}

// ============================================
// Internal Browser Action Title Helper
// ============================================

export function getInternalBrowserActionTitle(
  action: InternalBrowserAction
): string {
  return getToolDisplayLabelFromRegistry("control_internal_browser", action);
}

// ============================================
// Entry Builders
// ============================================

const PLACEHOLDER_URL = "browser://action";

type BrowserSubtool = "browser" | "internal_browser";

function extractBrowserUrl(event: SessionEvent): string | null {
  if (event.args) {
    if (typeof event.args === "string") return event.args;
    if (typeof event.args === "object") {
      const args = event.args as Record<string, unknown>;
      const url = args.url || args.targetUrl || args.uri || args.address;
      if (typeof url === "string") return url;
    }
  }

  if (!event.result) return null;
  if (typeof event.result === "string") return event.result;
  if (typeof event.result !== "object") return null;

  const result = event.result as Record<string, unknown>;
  const directUrl = result.url || result.uri;
  if (typeof directUrl === "string") return directUrl;

  for (const field of ["output", "content", "observation"] as const) {
    const raw = result[field];
    if (typeof raw !== "string") continue;
    const trimmed = raw.trimStart();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) continue;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed.url === "string") return parsed.url;
    } catch {
      // Not JSON
    }
  }

  return null;
}

function buildBrowserEntry(
  event: SessionEvent,
  currentEventId: string | null
): BrowserEntry {
  let url = extractBrowserUrl(event);
  let title: string | null = null;
  let subtitle: string | undefined;
  const args = getEventArgs(event);
  const action = deriveToolAction(event.functionName, args);

  if (!url) {
    const functionName = event.functionName.toLowerCase();
    if (functionName === "web_search") {
      const query =
        (args.search_term as string) ||
        (args.query as string) ||
        (args.q as string) ||
        "";
      title = getToolTitleFromRegistry(
        event.functionName,
        event.displayStatus,
        action
      );
      subtitle = query || undefined;
      url = "search://query";
    } else {
      url = PLACEHOLDER_URL;
    }
  }

  if (!title && action) {
    title = getToolTitleFromRegistry(
      event.functionName,
      event.displayStatus,
      action
    );
    subtitle = getBrowserEntrySubtitle(event, args);
  }

  return {
    entryId: event.id,
    event,
    url,
    title: title || getTitleFromUrl(url),
    subtitle,
    timestamp: event.createdAt,
    isCurrent: event.id === currentEventId,
  };
}

function buildInternalBrowserEntry(
  event: SessionEvent,
  currentEventId: string | null
): InternalBrowserEntry | null {
  const args = getEventArgs(event);
  const result = extractToolResultObject(event);

  const action = args?.action;
  if (typeof action !== "string") return null;

  const target = getRecordField(result, "target");
  const active = getRecordField(result, "active");
  const nestedResult = getRecordField(result, "result");
  const webviewLabel =
    getStringField(args, "webview") ||
    getStringField(args, "label") ||
    getStringField(target, "label") ||
    getStringField(active, "label") ||
    "internal-browser";
  const browserSessionId =
    getStringField(args, "browserSessionId") ||
    getStringField(args, "browser_session_id") ||
    getStringField(target, "browserSessionId") ||
    getStringField(target, "browser_session_id") ||
    getStringField(active, "browserSessionId") ||
    getStringField(active, "browser_session_id");

  return {
    entryId: event.id,
    event,
    action: action as InternalBrowserAction,
    webviewLabel,
    browserSessionId,
    timestamp: event.createdAt,
    isCurrent: event.id === currentEventId,
    index: typeof args?.index === "number" ? args.index : undefined,
    text: typeof args?.text === "string" ? args.text : undefined,
    option: typeof args?.option === "string" ? args.option : undefined,
    direction: typeof args?.direction === "string" ? args.direction : undefined,
    pages: typeof args?.pages === "number" ? args.pages : undefined,
    success:
      getBooleanField(result, "success") ??
      getBooleanField(nestedResult, "success"),
    message:
      getStringField(result, "message") ??
      getStringField(nestedResult, "message"),
    beforeUrl: getStringField(result, "beforeUrl"),
    actualUrl: getStringField(result, "actualUrl"),
    actualUrlChanged: getBooleanField(result, "actualUrlChanged"),
  };
}

function backfillPlaceholderUrls(browserEntries: BrowserEntry[]): void {
  let lastRealUrl: string | null = null;
  for (const entry of browserEntries) {
    if (
      entry.url !== PLACEHOLDER_URL &&
      !entry.url.startsWith("search://") &&
      !entry.url.startsWith("browser://")
    ) {
      lastRealUrl = entry.url;
    } else if (entry.url === PLACEHOLDER_URL && lastRealUrl) {
      entry.url = lastRealUrl;
    }
  }
}

function newerSubtoolFromEntries(options: {
  browserEntry: BrowserEntry | undefined;
  internalEntry: InternalBrowserEntry | undefined;
}): BrowserSubtool | null {
  if (options.internalEntry && options.browserEntry) {
    return new Date(options.internalEntry.timestamp) >
      new Date(options.browserEntry.timestamp)
      ? "internal_browser"
      : "browser";
  }
  if (options.internalEntry) return "internal_browser";
  if (options.browserEntry) return "browser";
  return null;
}

// ============================================
// Main Derive Function
// ============================================

export function deriveBrowserState(
  events: SessionEvent[],
  currentEventId: string | null
): Omit<
  SimulatorBrowserState,
  keyof import("@src/engines/Simulator/apps/core/types").SimulatorAppBaseState
> {
  const browserEntries: BrowserEntry[] = [];
  const internalBrowserEntries: InternalBrowserEntry[] = [];
  let activeEntry: BrowserEntry | null = null;
  let activeInternalEntry: InternalBrowserEntry | null = null;
  let activeSubtool: BrowserSubtool | null = null;
  let isMaskShown = false;

  for (const event of events) {
    const subtool = getAppSubtool(event.functionName);
    if (subtool === "internal_browser") {
      const entry = buildInternalBrowserEntry(event, currentEventId);
      if (!entry) continue;
      internalBrowserEntries.push(entry);
      activeInternalEntry = entry.isCurrent ? entry : activeInternalEntry;
      if (entry.action === "show_mask") {
        isMaskShown = true;
      } else if (entry.action === "hide_mask") {
        isMaskShown = false;
      }
      if (entry.isCurrent) {
        activeSubtool = "internal_browser";
      }
      continue;
    }

    if (subtool !== "browser" && subtool !== null) continue;
    const entry = buildBrowserEntry(event, currentEventId);
    browserEntries.push(entry);
    activeEntry = entry.isCurrent ? entry : activeEntry;
    if (entry.isCurrent) {
      activeSubtool = "browser";
    }
  }

  backfillPlaceholderUrls(browserEntries);

  activeEntry ??= browserEntries[browserEntries.length - 1] ?? null;
  activeInternalEntry ??=
    internalBrowserEntries[internalBrowserEntries.length - 1] ?? null;
  activeSubtool ??= newerSubtoolFromEntries({
    browserEntry: browserEntries[browserEntries.length - 1],
    internalEntry: internalBrowserEntries[internalBrowserEntries.length - 1],
  });

  return {
    browserEntries,
    activeEntry,
    currentUrl: activeEntry?.url || null,
    internalBrowserEntries,
    activeInternalEntry,
    activeWebview: activeInternalEntry?.webviewLabel || null,
    isMaskShown,
    activeSubtool,
  };
}

/**
 * Browser simulator app config.
 * Uses Rust registry for event matching.
 */
export const BROWSER_APP_CONFIG =
  defineSimulatorAppConfig<SimulatorBrowserState>({
    appType: AppType.BROWSER,
    name: "Browser",
    icon: "Globe",
    deriveState: deriveBrowserState,
  });
