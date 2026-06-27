/**
 * CanvasApp — Simulator panel for render_inline_canvas events.
 *
 * Layout follows the Browser SessionReplay pattern:
 *   SimulatorReplayChrome  → outer tab-bar chrome
 *   WorkStationShell       → primary sidebar (canvas list) + main content
 *   usePublishWorkstationTabHeader → Canvas/Source/Compare tab switcher
 *
 * Data source: useSimulatorAppState (appEvents filtered to render_inline_canvas).
 * canvasPreviewAtom is used only for "jump from chat" auto-selection.
 *
 * New in this version:
 * - Sidebar shows timestamp + title for each canvas event
 * - Multi-select (up to 2 items) enables a side-by-side diff view
 * - Diff uses a simple line-level diffLines utility (no external library)
 * - Source tab shows raw JSONL/HTML in a <pre> block
 */
import { useAtomValue, useSetAtom } from "jotai";
import { Layout, RefreshCw } from "lucide-react";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import DiffStatsBadge from "@src/components/DiffStatsBadge";
import IconButton from "@src/components/IconButton";
import TabPill from "@src/components/TabPill";
import { SIMULATOR_PRIMARY_SIDEBAR } from "@src/config/simulatorPrimarySidebar";
import A2UIRenderer from "@src/engines/ChatPanel/blocks/CanvasInlineCard/A2UIRenderer";
import {
  buildHtmlDocument,
  buildReactDocument,
} from "@src/engines/ChatPanel/blocks/CanvasInlineCard/canvasBuilder";
import type { CanvasInlineMode } from "@src/engines/ChatPanel/blocks/CanvasInlineCard/types";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { usePublishWorkstationTabHeader } from "@src/hooks/workStation";
import { SessionReplayCodeMirrorViewer } from "@src/modules/WorkStation/CodeEditor/SessionReplay/CodePanel/SessionReplayCodeMirrorViewer";
import {
  NoDragRegion,
  PrimarySidebarLayoutWithSections,
  SimulatorReplayChrome,
  WorkStationShell,
  buildPrimarySidebarConfig,
} from "@src/modules/WorkStation/shared";
import type { PrimarySidebarTab } from "@src/modules/WorkStation/shared/PrimarySidebarLayout/PrimarySidebarLayoutWithSections";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import { canvasPreviewAtom } from "@src/store/session/canvasPreviewAtom";
import {
  simulatorPrimarySidebarCollapsedAtom,
  simulatorPrimarySidebarPositionAtom,
  simulatorPrimarySidebarWidthAtom,
  simulatorPrimarySidebarWidthPersistAtom,
} from "@src/store/ui/simulatorAtom";

import type { SimulatorAppProps } from "../core/types";
import { useSimulatorAppState } from "../core/useSimulatorAppState";
import { CANVAS_APP_CONFIG } from "./canvasConfig";

// ─── types ────────────────────────────────────────────────────────────────────

type ViewTab = "canvas" | "source" | "compare";

interface CanvasPayload {
  mode: CanvasInlineMode;
  content?: string;
  url?: string;
  title?: string;
  streaming?: boolean;
}

function extractPayload(event: SessionEvent): CanvasPayload | null {
  const args = event.args as Record<string, unknown> | undefined;
  if (!args) return null;
  const mode = (args.mode as CanvasInlineMode | undefined) ?? "html";
  return {
    mode,
    content: args.content as string | undefined,
    url: args.url as string | undefined,
    title: args.title as string | undefined,
    streaming: false,
  };
}

function getDefaultTitle(
  payload: CanvasPayload,
  t: (key: string, fallback: string) => string
): string {
  if (payload.title) return payload.title;
  if (payload.mode === "url") return t("canvasCard.titleUrl", "Web Page");
  if (payload.mode === "a2ui") return t("canvasCard.titleA2ui", "Agent UI");
  if (payload.mode === "react")
    return t("canvasCard.titleReact", "React Preview");
  return t("canvasCard.titleHtml", "Agent Preview");
}

function formatEventTime(event: SessionEvent): string {
  const ts = (event as unknown as { timestamp?: number | string }).timestamp;
  if (!ts) return "";
  try {
    const d = new Date(typeof ts === "number" ? ts : ts);
    return d.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}

// ─── diff utility ─────────────────────────────────────────────────────────────

type DiffLine =
  | { kind: "equal"; text: string }
  | { kind: "added"; text: string }
  | { kind: "removed"; text: string };

/** Simple LCS-based line-level diff — no external library. */
function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");

  // Build LCS table
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0)
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) {
        dp[i][j] = 1 + dp[i + 1][j + 1];
      } else {
        dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  // Backtrack
  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      result.push({ kind: "equal", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ kind: "removed", text: a[i] });
      i++;
    } else {
      result.push({ kind: "added", text: b[j] });
      j++;
    }
  }
  while (i < m) {
    result.push({ kind: "removed", text: a[i++] });
  }
  while (j < n) {
    result.push({ kind: "added", text: b[j++] });
  }

  return result;
}

// ─── sidebar item ──────────────────────────────────────────────────────────────

interface SidebarItemProps {
  event: SessionEvent;
  isSelected: boolean;
  isCompareSelected: boolean;
  onSelect: () => void;
  onCompareToggle: () => void;
  t: (key: string, fallback: string) => string;
}

const SidebarItem: React.FC<SidebarItemProps> = ({
  event,
  isSelected,
  isCompareSelected,
  onSelect,
  onCompareToggle,
  t,
}) => {
  const payload = extractPayload(event);
  const title = payload ? getDefaultTitle(payload, t) : event.functionName;
  const timestamp = formatEventTime(event);

  return (
    <div
      className={[
        "group flex w-full items-center gap-1.5 rounded px-2 py-1.5 transition-colors",
        isSelected
          ? "bg-fill-3 text-text-1"
          : "text-text-2 hover:bg-fill-2 hover:text-text-1",
      ].join(" ")}
    >
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-start gap-1.5 text-left"
      >
        <Layout
          size={12}
          className={[
            "mt-0.5 shrink-0",
            isSelected ? "text-primary-6" : "text-text-4",
          ].join(" ")}
        />
        <div className="min-w-0 flex-1">
          <span className="block truncate text-xs">{title}</span>
          {timestamp && (
            <span className="block text-[10px] text-text-4">{timestamp}</span>
          )}
        </div>
      </button>
      {/* Compare checkbox — visible on hover or when active */}
      <button
        type="button"
        onClick={onCompareToggle}
        title={t("canvasApp.compareToggle", "Compare")}
        className={[
          "shrink-0 rounded px-1 py-0.5 text-[10px] font-medium transition-colors",
          isCompareSelected
            ? "bg-primary-6/20 text-primary-6"
            : "text-text-4 opacity-0 hover:text-text-2 group-hover:opacity-100",
        ].join(" ")}
      >
        {t("canvasApp.compareMark", "vs")}
      </button>
    </div>
  );
};

// ─── canvas sidebar content ────────────────────────────────────────────────────

interface CanvasSidebarProps {
  appEvents: SessionEvent[];
  selectedEventId: string | null;
  compareEventIds: string[];
  onSelect: (id: string) => void;
  onCompareToggle: (id: string) => void;
  t: (key: string, fallback: string) => string;
}

const CanvasSidebar: React.FC<CanvasSidebarProps> = ({
  appEvents,
  selectedEventId,
  compareEventIds,
  onSelect,
  onCompareToggle,
  t,
}) => {
  const sidebarTab = useMemo<PrimarySidebarTab>(
    () => ({
      key: "canvas-sidebar",
      label: t("canvasApp.sidebarTitle", "Canvases"),
      sections: [
        {
          key: "canvas-list",
          title: t("canvasApp.sidebarTitle", "Canvases"),
          content: (
            <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-2">
              {appEvents.length === 0 ? (
                <Placeholder
                  variant="empty"
                  title={t("canvasApp.noCanvases", "No canvases yet")}
                />
              ) : (
                appEvents.map((event) => (
                  <SidebarItem
                    key={event.id}
                    event={event}
                    isSelected={event.id === selectedEventId}
                    isCompareSelected={compareEventIds.includes(event.id)}
                    onSelect={() => onSelect(event.id)}
                    onCompareToggle={() => onCompareToggle(event.id)}
                    t={t}
                  />
                ))
              )}
            </div>
          ),
          defaultFlexGrow: 1,
          collapsible: true,
          resizable: false,
        },
      ],
    }),
    [appEvents, selectedEventId, compareEventIds, onSelect, onCompareToggle, t]
  );

  const handleTabChange = useCallback(() => {}, []);

  return (
    <>
      <PrimarySidebarLayoutWithSections
        tabs={[sidebarTab]}
        activeTab={sidebarTab.key}
        onTabChange={handleTabChange}
        hideTabs
      />
      {compareEventIds.length === 2 && (
        <div className="shrink-0 border-t border-border-1 px-3 py-2">
          <span className="text-[10px] text-primary-6">
            {t("canvasApp.compareHint", "2 selected — showing diff")}
          </span>
        </div>
      )}
    </>
  );
};

// ─── diff view ─────────────────────────────────────────────────────────────────

interface DiffViewProps {
  olderPayload: CanvasPayload;
  newerPayload: CanvasPayload;
  olderTitle: string;
  newerTitle: string;
}

const DiffView: React.FC<DiffViewProps> = ({
  olderPayload,
  newerPayload,
  olderTitle,
  newerTitle,
}) => {
  const oldText =
    olderPayload.mode === "url"
      ? (olderPayload.url ?? "")
      : (olderPayload.content ?? "");
  const newText =
    newerPayload.mode === "url"
      ? (newerPayload.url ?? "")
      : (newerPayload.content ?? "");
  const diff = useMemo(() => diffLines(oldText, newText), [oldText, newText]);

  const addedCount = diff.filter((l) => l.kind === "added").length;
  const removedCount = diff.filter((l) => l.kind === "removed").length;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* diff header */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border-1 bg-fill-2 px-3 py-1.5 text-xs">
        <span className="truncate text-text-2">{olderTitle}</span>
        <span className="shrink-0 text-text-4">→</span>
        <span className="truncate text-text-2">{newerTitle}</span>
        <DiffStatsBadge
          additions={addedCount}
          deletions={removedCount}
          variant="plain"
          size="sm"
          className="ml-auto"
        />
      </div>
      {/* diff lines */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <pre className="min-w-0 p-3 font-mono text-[11px] leading-5">
          {diff.map((line, i) => (
            <div
              key={i}
              className={[
                "whitespace-pre-wrap break-all px-2",
                line.kind === "added"
                  ? "bg-green-500/10 text-green-400"
                  : line.kind === "removed"
                    ? "bg-red-500/10 text-red-400"
                    : "text-text-3",
              ].join(" ")}
            >
              <span className="mr-2 select-none text-text-4/50">
                {line.kind === "added"
                  ? "+"
                  : line.kind === "removed"
                    ? "-"
                    : " "}
              </span>
              {line.text}
            </div>
          ))}
        </pre>
      </div>
    </div>
  );
};

// ─── iframe viewer ─────────────────────────────────────────────────────────────

interface CanvasIframeProps {
  payload: CanvasPayload;
  reloadKey: number;
  title: string;
}

const CanvasIframe: React.FC<CanvasIframeProps> = ({
  payload,
  reloadKey,
  title,
}) => {
  const { t } = useTranslation("sessions");

  const a2uiLines = useMemo(() => {
    if (payload.mode !== "a2ui" || !payload.content) return [];
    return payload.content.split("\n").filter(Boolean);
  }, [payload.mode, payload.content]);

  const htmlSrcDoc = useMemo(() => {
    if (payload.mode === "html" && payload.content)
      return buildHtmlDocument(payload.content);
    return undefined;
  }, [payload.mode, payload.content]);

  const reactSrcDoc = useMemo(() => {
    if (payload.mode === "react" && payload.content)
      return buildReactDocument(payload.content);
    return undefined;
  }, [payload.mode, payload.content]);

  if (payload.mode === "url" && payload.url) {
    return (
      <iframe
        key={`url-${reloadKey}`}
        src={payload.url}
        className="h-full w-full border-0"
        sandbox="allow-scripts allow-same-origin allow-forms"
        title={title}
      />
    );
  }

  if (payload.mode === "a2ui" && a2uiLines.length > 0) {
    return <A2UIRenderer lines={a2uiLines} className="h-full" />;
  }

  if (reactSrcDoc) {
    return (
      <iframe
        key={`react-${reloadKey}`}
        srcDoc={reactSrcDoc}
        className="h-full w-full border-0"
        sandbox="allow-scripts"
        title={title}
      />
    );
  }

  if (htmlSrcDoc) {
    return (
      <iframe
        key={`doc-${reloadKey}`}
        srcDoc={htmlSrcDoc}
        className="h-full w-full border-0"
        sandbox="allow-scripts"
        title={title}
      />
    );
  }

  return (
    <div className="flex h-full items-center justify-center">
      <span className="text-xs text-text-4">
        {payload.streaming
          ? t("canvasCard.waiting", "Waiting for content…")
          : t("canvasCard.empty", "No content")}
      </span>
    </div>
  );
};

// ─── tab header content ───────────────────────────────────────────────────────

interface CanvasTabHeaderProps {
  tab: ViewTab;
  onSetTab: (tab: ViewTab) => void;
  title: string;
  isStreaming: boolean;
  onReload: () => void;
  showCompare: boolean;
}

const CanvasTabHeader: React.FC<CanvasTabHeaderProps> = ({
  tab,
  onSetTab,
  title,
  isStreaming,
  onReload,
  showCompare,
}) => {
  const { t } = useTranslation("sessions");

  const tabs: ViewTab[] = showCompare
    ? ["canvas", "source", "compare"]
    : ["canvas", "source"];

  return (
    <NoDragRegion className="flex min-w-0 flex-1 items-center gap-2 px-2">
      <Layout size={13} className="shrink-0 text-primary-6" />
      <span className="min-w-0 truncate text-xs font-medium text-text-2">
        {title}
      </span>
      {isStreaming && (
        <span
          aria-hidden
          className="ml-0.5 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary-6"
        />
      )}

      <div className="ml-auto flex items-center gap-1">
        <TabPill
          variant="pill"
          size="mini"
          fillWidth={false}
          tabs={tabs}
          activeTab={tab}
          onChange={(key) => onSetTab(key as ViewTab)}
        />
        {tab === "canvas" && !isStreaming && (
          <IconButton
            onClick={onReload}
            className="text-text-4 hover:bg-fill-3 hover:text-text-2"
            title={t("canvasCard.reload", "Reload")}
          >
            <RefreshCw size={12} />
          </IconButton>
        )}
      </div>
    </NoDragRegion>
  );
};

// ─── main component ────────────────────────────────────────────────────────────

const CanvasApp: React.FC<SimulatorAppProps> = () => {
  const { t } = useTranslation("sessions");

  const { appEvents } = useSimulatorAppState({
    config: CANVAS_APP_CONFIG as never,
  });

  const canvasPreviewEntry = useAtomValue(canvasPreviewAtom);

  // ── sidebar atoms ────────────────────────────────────────────────────────
  const primarySidebarCollapsed = useAtomValue(
    simulatorPrimarySidebarCollapsedAtom
  );
  const primarySidebarPosition = useAtomValue(
    simulatorPrimarySidebarPositionAtom
  );
  const primarySidebarWidth = useAtomValue(simulatorPrimarySidebarWidthAtom);
  const setPrimarySidebarWidthPersist = useSetAtom(
    simulatorPrimarySidebarWidthPersistAtom
  );

  const handlePrimarySidebarWidthChange = useCallback(
    (width: number) => {
      setPrimarySidebarWidthPersist(width);
    },
    [setPrimarySidebarWidthPersist]
  );

  // ── selection state ──────────────────────────────────────────────────────

  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [compareEventIds, setCompareEventIds] = useState<string[]>([]);
  const prevEventCountRef = useRef(0);

  // Auto-advance to the latest event when a new one arrives
  useEffect(() => {
    if (appEvents.length === 0) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedEventId(null);
      prevEventCountRef.current = 0;
      return;
    }
    if (appEvents.length > prevEventCountRef.current) {
      prevEventCountRef.current = appEvents.length;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSelectedEventId(appEvents[appEvents.length - 1].id);
    }
  }, [appEvents]);

  // Jump to matching event when canvasPreviewAtom changes (chat card click)
  useEffect(() => {
    if (!canvasPreviewEntry) return;
    const preview = canvasPreviewEntry.payload;
    const match = appEvents.find((ev) => {
      const args = ev.args as Record<string, unknown> | undefined;
      if (!args) return false;
      return (
        args.mode === preview.mode &&
        (preview.title ? args.title === preview.title : true)
      );
    });
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (match) setSelectedEventId(match.id);
  }, [canvasPreviewEntry, appEvents]);

  const handleCompareToggle = useCallback((id: string) => {
    setCompareEventIds((prev) => {
      if ((prev as string[]).includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 2) return [prev[1], id];
      return [...prev, id];
    });
  }, []);

  const selectedEvent = useMemo(
    () => appEvents.find((ev) => ev.id === selectedEventId) ?? null,
    [appEvents, selectedEventId]
  );

  const selectedPayload = useMemo(
    () => (selectedEvent ? extractPayload(selectedEvent) : null),
    [selectedEvent]
  );

  // Compare payloads (only valid when exactly 2 are selected)
  const comparePayloads = useMemo(() => {
    if (compareEventIds.length !== 2) return null;
    const [idA, idB] = compareEventIds;
    const evA = appEvents.find((e) => e.id === idA);
    const evB = appEvents.find((e) => e.id === idB);
    if (!evA || !evB) return null;
    const pA = extractPayload(evA);
    const pB = extractPayload(evB);
    if (!pA || !pB) return null;
    // Determine order by position in appEvents array
    const idxA = appEvents.indexOf(evA);
    const idxB = appEvents.indexOf(evB);
    return idxA <= idxB
      ? {
          older: pA,
          olderTitle: getDefaultTitle(pA, t),
          newer: pB,
          newerTitle: getDefaultTitle(pB, t),
        }
      : {
          older: pB,
          olderTitle: getDefaultTitle(pB, t),
          newer: pA,
          newerTitle: getDefaultTitle(pA, t),
        };
  }, [compareEventIds, appEvents, t]);

  // ── tab + reload state ───────────────────────────────────────────────────

  const [activeTab, setActiveTab] = useState<ViewTab>("canvas");
  const [reloadKey, setReloadKey] = useState(0);

  // Reset reload key and tab when selection changes
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReloadKey((k) => k + 1);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveTab("canvas");
  }, [selectedEventId]);

  // Auto-switch to compare tab when 2 items are selected
  useEffect(() => {
    if (compareEventIds.length === 2) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveTab("compare");
    } else if (activeTab === "compare") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveTab("canvas");
    }
    // activeTab intentionally omitted — only react to compareEventIds changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compareEventIds]);

  const handleReload = useCallback(() => {
    setReloadKey((k) => k + 1);
  }, []);

  const cardTitle = selectedPayload
    ? getDefaultTitle(selectedPayload, t)
    : t("canvasCard.titleHtml", "Agent Preview");

  // ── publish to SimulatorWorkstationTabHeader ─────────────────────────────

  const headerContent = useMemo(
    () =>
      appEvents.length > 0 && selectedPayload ? (
        <CanvasTabHeader
          tab={activeTab}
          onSetTab={setActiveTab}
          title={cardTitle}
          isStreaming={selectedPayload.streaming ?? false}
          onReload={handleReload}
          showCompare={compareEventIds.length === 2}
        />
      ) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      appEvents.length,
      selectedPayload,
      activeTab,
      cardTitle,
      handleReload,
      compareEventIds.length,
    ]
  );

  usePublishWorkstationTabHeader({
    host: "simulator",
    content: headerContent,
    enabled: appEvents.length > 0 && selectedPayload !== null,
  });

  // ── primary sidebar config ───────────────────────────────────────────────

  const primarySidebarConfig = useMemo(
    () =>
      buildPrimarySidebarConfig({
        content: (
          <CanvasSidebar
            appEvents={appEvents}
            selectedEventId={selectedEventId}
            compareEventIds={compareEventIds}
            onSelect={setSelectedEventId}
            onCompareToggle={handleCompareToggle}
            t={t}
          />
        ),
        collapsed: primarySidebarCollapsed,
        size: primarySidebarWidth,
        onSizeChange: handlePrimarySidebarWidthChange,
        minSize: SIMULATOR_PRIMARY_SIDEBAR.minWidth,
        maxSize: SIMULATOR_PRIMARY_SIDEBAR.maxWidth,
        resetSize: SIMULATOR_PRIMARY_SIDEBAR.defaultWidth,
      }),
    [
      appEvents,
      selectedEventId,
      compareEventIds,
      primarySidebarCollapsed,
      primarySidebarWidth,
      handlePrimarySidebarWidthChange,
      handleCompareToggle,
      t,
    ]
  );

  // ── main content area ────────────────────────────────────────────────────

  const mainContent = (
    <div className="relative min-h-0 flex-1 overflow-hidden bg-bg-2">
      {appEvents.length === 0 ? (
        <Placeholder
          variant="empty"
          placement="detail-panel"
          title={t("canvasApp.empty", "No canvas rendered yet")}
          fillParentHeight
        />
      ) : !selectedPayload ? (
        <Placeholder
          variant="empty"
          placement="detail-panel"
          title={t("canvasCard.empty", "No content")}
          fillParentHeight
        />
      ) : activeTab === "compare" && comparePayloads ? (
        <DiffView
          olderPayload={comparePayloads.older}
          newerPayload={comparePayloads.newer}
          olderTitle={comparePayloads.olderTitle}
          newerTitle={comparePayloads.newerTitle}
        />
      ) : activeTab === "canvas" ? (
        <>
          <CanvasIframe
            payload={selectedPayload}
            reloadKey={reloadKey}
            title={cardTitle}
          />
          {selectedPayload.streaming && (
            <div
              className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 animate-pulse bg-primary-6/40"
              aria-hidden
            />
          )}
        </>
      ) : (
        /* source tab */
        <SessionReplayCodeMirrorViewer
          content={
            selectedPayload.mode === "url"
              ? (selectedPayload.url ?? "")
              : (selectedPayload.content ?? "")
          }
          language={selectedPayload.mode === "url" ? "plaintext" : "html"}
          filePath={selectedPayload.mode === "html" ? "canvas.html" : undefined}
        />
      )}
    </div>
  );

  return (
    <SimulatorReplayChrome
      tabs={[]}
      activeEventId={selectedEventId ?? ""}
      onTabClick={() => {}}
    >
      <div className="flex min-h-0 flex-1">
        <WorkStationShell
          primarySidebarConfig={primarySidebarConfig}
          content={mainContent}
          statusBar={null}
          layoutMode={primarySidebarPosition === "right" ? "right" : "left"}
          appClassName="canvas-app"
        />
      </div>
    </SimulatorReplayChrome>
  );
};

CanvasApp.displayName = "CanvasApp";
export default CanvasApp;
