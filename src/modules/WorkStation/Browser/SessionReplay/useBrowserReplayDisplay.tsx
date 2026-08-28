/**
 * useBrowserReplayDisplay
 *
 * Derives all display data, header info, and native content for the
 * Browser Session Replay view. Pure derived-data — no side effects.
 *
 * Extracted from SessionReplay/index.tsx to keep it under 600 lines.
 */
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import AnyIcon from "@src/components/AnyIcon";
import { getEventIcon } from "@src/config/toolIcons";
import {
  AlertCircleIcon as AlertCircle,
  CheckmarkCircle01Icon as CheckCircle2,
  InternetIcon as Chrome,
  FileSymlinkIcon as FileSymlink,
  InternetIcon as Globe,
  HugeiconsIcon,
  MonitorIcon as Monitor,
  ComputerPhoneSyncIcon as MonitorSmartphone,
  Search01Icon as Search,
} from "@src/icons";
import { deriveToolAction } from "@src/util/ui/rendering/toolAction";

import { getInternalBrowserActionTitle } from "./config";
import type { BrowserEntry, InternalBrowserEntry } from "./types";
import {
  extractEventScreenshot,
  extractEventText,
  extractEventUrl,
} from "./utils/browserEventUtils";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface HeaderInfo {
  categoryIcon: React.ReactNode;
  categoryLabel: string;
  detailIcon: React.ReactNode | null;
  detailText: string | null;
}

export interface DisplayData {
  screenshot: string | null;
  text: string | null;
  url: string | null;
  action: string | null;
  isLive: boolean;
}

interface BrowserReplayDisplayOptions {
  activeEntry: BrowserEntry | null | undefined;
  activeInternalEntry: InternalBrowserEntry | null | undefined;
  activeSubtool: string | null | undefined;
  isAutomationActive: boolean;
  automation: {
    lastScreenshot: string | null;
    currentUrl: string | null;
    lastAction: string | null;
  };
  cache: Map<string, string>;
}

// ── Helper ────────────────────────────────────────────────────────────────────

function renderNativeBrowserDomContent(
  entry: InternalBrowserEntry
): string | null {
  const result = entry.event.result as Record<string, unknown> | undefined;
  if (!result) return null;
  if (typeof result.content === "string") return result.content;
  if (typeof result.output === "string") return result.output;
  if (typeof result.observation === "string") return result.observation;
  if (typeof result === "object") {
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return null;
    }
  }
  return null;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useBrowserReplayDisplay({
  activeEntry,
  activeInternalEntry,
  activeSubtool,
  isAutomationActive,
  automation,
  cache,
}: BrowserReplayDisplayOptions) {
  const { t } = useTranslation("sessions");

  // ── displayData ─────────────────────────────────────────────────────────────

  const displayData = useMemo<DisplayData | null>(() => {
    if (isAutomationActive && automation.lastScreenshot) {
      return {
        screenshot: automation.lastScreenshot,
        text: null,
        url: automation.currentUrl,
        action: automation.lastAction,
        isLive: true,
      };
    }

    if (activeEntry) {
      const eventScreenshot = extractEventScreenshot(activeEntry.event, cache);
      const eventUrl = extractEventUrl(activeEntry.event) || activeEntry.url;
      const eventText = extractEventText(activeEntry.event);

      if (eventScreenshot) {
        return {
          screenshot: eventScreenshot,
          text: eventText,
          url: eventUrl,
          action: activeEntry.event.functionName || null,
          isLive: false,
        };
      }

      if (eventText) {
        return {
          screenshot: null,
          text: eventText,
          url: eventUrl,
          action: activeEntry.event.functionName || null,
          isLive: false,
        };
      }
    }

    if (automation.lastScreenshot) {
      return {
        screenshot: automation.lastScreenshot,
        text: null,
        url: automation.currentUrl,
        action: automation.lastAction,
        isLive: false,
      };
    }

    return null;
  }, [activeEntry, isAutomationActive, automation, cache]);

  // ── headerInfo ──────────────────────────────────────────────────────────────

  const headerInfo = useMemo<HeaderInfo | null>(() => {
    if (!displayData) return null;

    const isSearch =
      displayData.action === "web_search" || displayData.action === "WebSearch";
    const isFetch =
      displayData.action === "web_fetch" || displayData.action === "WebFetch";

    let CategoryIcon = Chrome;
    let categoryLabel =
      activeEntry?.title ||
      t("simulator.replay.browser.header.categoryBrowser");
    const iconColor = displayData.isLive ? "text-primary-6" : "text-text-2";

    if (displayData.isLive) {
      CategoryIcon = Monitor;
      categoryLabel = t("simulator.replay.browser.header.categoryLiveBrowser");
    } else if (isSearch) {
      CategoryIcon = Search;
      categoryLabel = t("simulator.replay.browser.header.categoryWebSearch");
    } else if (isFetch) {
      CategoryIcon = FileSymlink;
      categoryLabel = t("simulator.replay.browser.header.categoryWebFetch");
    }

    let detailIcon: React.ReactNode | null = null;
    let detailText: string | null = activeEntry?.subtitle || null;
    const url = displayData.url;
    const categoryIconNode =
      activeEntry && !displayData.isLive && !isSearch && !isFetch
        ? getEventIcon(activeEntry.event.functionName, {
            action: deriveToolAction(
              activeEntry.event.functionName,
              activeEntry.event.args as Record<string, unknown> | undefined
            ),
            size: 14,
            className: `flex-shrink-0 ${iconColor}`,
          })
        : null;

    if (isSearch) {
      if (activeEntry) {
        const title = activeEntry.title;
        detailText = title.startsWith("Search: ") ? title.slice(8) : title;
      } else if (url?.startsWith("search://")) {
        detailText = decodeURIComponent(url.slice(9));
      }
    } else if (
      !detailText &&
      url &&
      !url.startsWith("search://") &&
      !url.startsWith("browser://")
    ) {
      detailIcon = (
        <HugeiconsIcon
          icon={Globe}
          data-icon="globe"
          size={14}
          className="flex-shrink-0 text-text-3"
        />
      );
      detailText = url.replace(/^https?:\/\//, "");
    } else if (!detailText && displayData.action) {
      detailText = displayData.action;
    }

    return {
      categoryIcon: categoryIconNode || (
        <AnyIcon
          icon={CategoryIcon}
          size={14}
          className={`flex-shrink-0 ${iconColor}`}
        />
      ),
      categoryLabel,
      detailIcon,
      detailText,
    };
  }, [displayData, activeEntry, t]);

  // ── nativeHeaderInfo ────────────────────────────────────────────────────────

  const nativeHeaderInfo = useMemo<HeaderInfo | null>(() => {
    if (!activeInternalEntry) return null;

    const actionTitle = getInternalBrowserActionTitle(
      activeInternalEntry.action
    );
    const iconColor = activeInternalEntry.isCurrent
      ? "text-primary-6"
      : "text-text-2";

    let resultIcon: React.ReactNode | null = null;
    if (activeInternalEntry.success === true) {
      resultIcon = (
        <HugeiconsIcon
          icon={CheckCircle2}
          data-icon="check-circle-2"
          size={14}
          className="flex-shrink-0 text-success-6"
        />
      );
    } else if (activeInternalEntry.success === false) {
      resultIcon = (
        <HugeiconsIcon
          icon={AlertCircle}
          data-icon="alert-circle"
          size={14}
          className="text-error-6 flex-shrink-0"
        />
      );
    }

    let detailText: string | null = null;
    switch (activeInternalEntry.action) {
      case "click":
      case "input":
      case "select":
        detailText =
          activeInternalEntry.index !== undefined
            ? `Element [${activeInternalEntry.index}]`
            : null;
        break;
      case "scroll":
        detailText = activeInternalEntry.direction ?? null;
        break;
      default:
        detailText = null;
    }

    return {
      categoryIcon: (
        <HugeiconsIcon
          icon={MonitorSmartphone}
          data-icon="monitor-smartphone"
          size={14}
          className={`flex-shrink-0 ${iconColor}`}
        />
      ),
      categoryLabel: actionTitle,
      detailIcon: resultIcon,
      detailText,
    };
  }, [activeInternalEntry]);

  // ── nativeDisplayContent ────────────────────────────────────────────────────

  const nativeDisplayContent = useMemo<React.ReactNode>(() => {
    if (!activeInternalEntry) return null;

    if (activeInternalEntry.action === "get_state") {
      const domContent = renderNativeBrowserDomContent(activeInternalEntry);
      if (domContent) {
        return (
          <div className="scrollbar-overlay h-full overflow-y-auto p-4 pb-[100px]">
            <pre className="whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-text-2">
              {domContent}
            </pre>
          </div>
        );
      }
    }

    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
        <div className="flex flex-col items-center gap-2">
          {activeInternalEntry.success === true ? (
            <HugeiconsIcon
              icon={CheckCircle2}
              data-icon="check-circle-2"
              size={48}
              className="text-success-6"
            />
          ) : activeInternalEntry.success === false ? (
            <HugeiconsIcon
              icon={AlertCircle}
              data-icon="alert-circle"
              size={48}
              className="text-error-6"
            />
          ) : (
            <HugeiconsIcon
              icon={MonitorSmartphone}
              data-icon="monitor-smartphone"
              size={48}
              className="text-text-3"
            />
          )}
          <h3 className="text-lg font-medium text-text-1">
            {getInternalBrowserActionTitle(activeInternalEntry.action)}
          </h3>
          {activeInternalEntry.message && (
            <p className="max-w-md text-center text-sm text-text-2">
              {activeInternalEntry.message}
            </p>
          )}
        </div>
        <div className="mt-4 flex flex-col gap-2 text-sm">
          {activeInternalEntry.index !== undefined && (
            <div className="flex gap-2">
              <span className="text-text-3">Element:</span>
              <span className="font-mono text-text-1">
                [{activeInternalEntry.index}]
              </span>
            </div>
          )}
          {activeInternalEntry.text && (
            <div className="flex gap-2">
              <span className="text-text-3">Text:</span>
              <span className="text-text-1">
                &quot;{activeInternalEntry.text}&quot;
              </span>
            </div>
          )}
          {activeInternalEntry.option && (
            <div className="flex gap-2">
              <span className="text-text-3">Option:</span>
              <span className="text-text-1">
                &quot;{activeInternalEntry.option}&quot;
              </span>
            </div>
          )}
          {activeInternalEntry.direction && (
            <div className="flex gap-2">
              <span className="text-text-3">Direction:</span>
              <span className="text-text-1">
                {activeInternalEntry.direction}
              </span>
            </div>
          )}
          <div className="flex gap-2">
            <span className="text-text-3">Webview:</span>
            <span className="font-mono text-text-1">
              {activeInternalEntry.webviewLabel}
            </span>
          </div>
        </div>
      </div>
    );
  }, [activeInternalEntry]);

  // ── activeSubtool-aware display decision ─────────────────────────────────────

  const activeEntryId = useMemo(() => {
    if (activeSubtool === "internal_browser" && activeInternalEntry) {
      return activeInternalEntry.entryId;
    }
    if (activeEntry) return activeEntry.entryId;
    return null;
  }, [activeSubtool, activeInternalEntry, activeEntry]);

  return {
    displayData,
    headerInfo,
    nativeHeaderInfo,
    nativeDisplayContent,
    activeEntryId,
  };
}
