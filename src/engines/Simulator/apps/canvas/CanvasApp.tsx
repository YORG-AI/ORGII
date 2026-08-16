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
import { Layout, PenTool, RefreshCw, Share2 } from "lucide-react";
import React, { Suspense, lazy, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import DiffStatsBadge from "@src/components/DiffStatsBadge";
import IconButton from "@src/components/IconButton";
import TabPill from "@src/components/TabPill";
import { NoDragRegion } from "@src/components/WindowChrome";
import { SIMULATOR_PRIMARY_SIDEBAR } from "@src/config/simulatorPrimarySidebar";
import CanvasRevisionProgress from "@src/engines/ChatPanel/blocks/CanvasInlineCard/CanvasRevisionProgress";
import { isCanvasRevisionDraftRelevant } from "@src/engines/ChatPanel/blocks/CanvasInlineCard/canvasRevisionProgressState";
import type { CanvasInlineMode } from "@src/engines/ChatPanel/blocks/CanvasInlineCard/types";
import { useCanvasRevisionDraftForSession } from "@src/engines/SessionCore";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import {
  CanvasShareDialog,
  getCanvasShareAvailability,
  useCanvasShareDialog,
} from "@src/features/CanvasShare";
import { usePublishWorkstationTabHeader } from "@src/hooks/tabHost/useWorkstationTabHeader";
import {
  PrimarySidebarLayoutWithSections,
  SimulatorReplayChrome,
  WorkStationShell,
  WorkstationHeaderSectionSeparator,
  WorkstationToolbarTooltip,
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
import { diffLines, isCanvasDiffInputTooLarge } from "./canvasDiff";
import {
  type CanvasViewTab,
  createCanvasInteractionState,
  reconcileCanvasInteractionState,
  reloadCanvas,
  selectCanvasEvent,
  setCanvasViewTab,
  toggleCanvasComparison,
} from "./canvasInteractionState";
import { projectLatestCanvasEvents } from "./canvasRevisionProjection";
import CanvasDesignSurface from "./design/CanvasDesignSurface";

// Lazy: the "source" tab is the only CodeMirror user in the canvas app.
const SessionReplayCodeMirrorViewer = lazy(() =>
  import("@src/modules/WorkStation/CodeEditor/SessionReplay/CodePanel/SessionReplayCodeMirrorViewer").then(
    (mod) => ({ default: mod.SessionReplayCodeMirrorViewer })
  )
);

// ─── types ────────────────────────────────────────────────────────────────────

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
    streaming: args.streaming === true,
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
            : "text-text-4 opacity-0 hover:text-text-2 focus-visible:opacity-100 group-hover:opacity-100",
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
  const { t } = useTranslation("sessions");
  const oldText =
    olderPayload.mode === "url"
      ? (olderPayload.url ?? "")
      : (olderPayload.content ?? "");
  const newText =
    newerPayload.mode === "url"
      ? (newerPayload.url ?? "")
      : (newerPayload.content ?? "");
  const tooLarge = isCanvasDiffInputTooLarge(oldText, newText);
  const diff = useMemo(
    () => (tooLarge ? [] : diffLines(oldText, newText)),
    [tooLarge, oldText, newText]
  );

  const addedCount = diff.filter((l) => l.kind === "added").length;
  const removedCount = diff.filter((l) => l.kind === "removed").length;

  if (tooLarge) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <span className="text-xs text-text-4">
          {t(
            "canvasApp.compareTooLarge",
            "These versions are too large to compare"
          )}
        </span>
      </div>
    );
  }

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
                  ? "bg-success-6/10 text-success-6"
                  : line.kind === "removed"
                    ? "bg-danger-6/10 text-danger-6"
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
  eventId: string;
  sessionId: string;
  designEnabled: boolean;
}

const CanvasIframe: React.FC<CanvasIframeProps> = ({
  payload,
  reloadKey,
  title,
  eventId,
  sessionId,
  designEnabled,
}) => {
  return (
    <CanvasDesignSurface
      // `designEnabled` is deliberately not part of the key: the inspector
      // effect handles enable/disable without remounting, and a remount would
      // reset the rendered artifact's state on every design toggle.
      key={`${eventId}:${reloadKey}`}
      payload={payload}
      reloadKey={reloadKey}
      title={title}
      eventId={eventId}
      sessionId={sessionId}
      designEnabled={designEnabled}
    />
  );
};

// ─── tab header content ───────────────────────────────────────────────────────

interface CanvasTabHeaderProps {
  tab: CanvasViewTab;
  onSetTab: (tab: CanvasViewTab) => void;
  title: string;
  isStreaming: boolean;
  onReload: () => void;
  showCompare: boolean;
  designAvailable: boolean;
  designEnabled: boolean;
  onToggleDesign: () => void;
  shareEnabled: boolean;
  shareHint: string;
  onShare: () => void;
}

const CanvasTabHeader: React.FC<CanvasTabHeaderProps> = ({
  tab,
  onSetTab,
  title,
  isStreaming,
  onReload,
  showCompare,
  designAvailable,
  designEnabled,
  onToggleDesign,
  shareEnabled,
  shareHint,
  onShare,
}) => {
  const { t } = useTranslation("sessions");

  const tabs: CanvasViewTab[] = showCompare
    ? ["canvas", "source", "compare"]
    : ["canvas", "source"];

  return (
    <NoDragRegion className="flex min-w-0 flex-1 items-center gap-2">
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
        {tab === "canvas" && (
          <WorkstationToolbarTooltip
            label={
              designAvailable
                ? t("canvasApp.designHint", "Select an element to change")
                : t("canvasApp.designUnavailable", "Design is unavailable")
            }
          >
            <Button
              htmlType="button"
              variant="tertiary"
              size="mini"
              icon={<PenTool size={12} />}
              onClick={onToggleDesign}
              disabled={!designAvailable}
              aria-pressed={designEnabled}
              className={designEnabled ? "!bg-primary-2 !text-primary-6" : ""}
            >
              {t("canvasApp.design", "Design")}
            </Button>
          </WorkstationToolbarTooltip>
        )}
        <TabPill
          variant="pill"
          size="mini"
          fillWidth={false}
          tabs={tabs}
          activeTab={tab}
          onChange={(key) => onSetTab(key as CanvasViewTab)}
        />
        <WorkstationHeaderSectionSeparator className="mx-0.5" />
        {tab === "canvas" && !isStreaming && (
          <IconButton
            onClick={onReload}
            className="text-text-4 hover:bg-fill-3 hover:text-text-2"
            title={t("canvasCard.reload", "Reload")}
          >
            <RefreshCw size={12} />
          </IconButton>
        )}
        <WorkstationToolbarTooltip label={shareHint}>
          <Button
            htmlType="button"
            variant="tertiary"
            size="mini"
            icon={<Share2 size={12} />}
            onClick={onShare}
            disabled={!shareEnabled}
          >
            {t("canvasApp.share", "Share")}
          </Button>
        </WorkstationToolbarTooltip>
      </div>
    </NoDragRegion>
  );
};

// ─── main component ────────────────────────────────────────────────────────────

const CanvasApp: React.FC<SimulatorAppProps> = () => {
  const { t } = useTranslation("sessions");
  const {
    state: canvasShareState,
    open: openCanvasShare,
    close: closeCanvasShare,
    retry: retryCanvasShare,
    retryShortLink: retryCanvasShareShortLink,
    copy: copyCanvasShare,
  } = useCanvasShareDialog();

  const { appEvents: canvasRenderEvents } = useSimulatorAppState({
    config: CANVAS_APP_CONFIG as never,
  });
  const appEvents = useMemo(
    () => projectLatestCanvasEvents(canvasRenderEvents),
    [canvasRenderEvents]
  );

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

  const appEventIds = useMemo(
    () => appEvents.map((event) => event.id),
    [appEvents]
  );
  const previewEventId = canvasPreviewEntry?.payload.eventId ?? null;
  const [interactionState, setInteractionState] = useState(() =>
    createCanvasInteractionState(appEventIds, previewEventId)
  );
  const [designEventId, setDesignEventId] = useState<string | null>(null);

  // React's render-time adjustment pattern keeps external event/preview facts
  // and the committed UI in the same render, without a cascading Effect pass.
  const reconciledInteractionState = reconcileCanvasInteractionState(
    interactionState,
    appEventIds,
    previewEventId,
    designEventId
  );
  if (reconciledInteractionState !== interactionState) {
    setInteractionState(reconciledInteractionState);
  }

  const { selectedEventId, compareEventIds, activeTab, reloadKey } =
    reconciledInteractionState;

  const handleSelect = useCallback((id: string) => {
    setInteractionState((state) => selectCanvasEvent(state, id));
  }, []);

  const handleCompareToggle = useCallback((id: string) => {
    setDesignEventId(null);
    setInteractionState((state) => toggleCanvasComparison(state, id));
  }, []);

  const selectedEvent = useMemo(
    () => appEvents.find((ev) => ev.id === selectedEventId) ?? null,
    [appEvents, selectedEventId]
  );

  const selectedPayload = useMemo(
    () => (selectedEvent ? extractPayload(selectedEvent) : null),
    [selectedEvent]
  );
  const activeSessionId =
    selectedEvent?.sessionId ?? canvasPreviewEntry?.sessionId ?? null;
  const revisionDraftCandidate =
    useCanvasRevisionDraftForSession(activeSessionId);
  const revisionDraft = isCanvasRevisionDraftRelevant(
    revisionDraftCandidate,
    activeSessionId,
    selectedEventId
  )
    ? revisionDraftCandidate
    : null;

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

  const handleSetTab = useCallback((tab: CanvasViewTab) => {
    if (tab !== "canvas") setDesignEventId(null);
    setInteractionState((state) => setCanvasViewTab(state, tab));
  }, []);

  const handleReload = useCallback(() => {
    setInteractionState(reloadCanvas);
  }, []);

  const cardTitle = selectedPayload
    ? getDefaultTitle(selectedPayload, t)
    : t("canvasCard.titleHtml", "Agent Preview");
  const designAvailable =
    activeTab === "canvas" &&
    selectedPayload !== null &&
    selectedPayload.mode !== "url" &&
    !selectedPayload.streaming &&
    revisionDraft === null;
  const designEnabled =
    designAvailable &&
    selectedEventId !== null &&
    designEventId === selectedEventId;
  const handleToggleDesign = useCallback(() => {
    if (!selectedEventId) return;
    setDesignEventId((current) =>
      current === selectedEventId ? null : selectedEventId
    );
  }, [selectedEventId]);
  // Boolean projection: `revisionDraft.receivedCharacters` changes at 20Hz —
  // memos keyed on the draft object would recompute on every tick.
  const revisionActive = revisionDraft !== null;
  const shareAvailability = useMemo(
    () =>
      getCanvasShareAvailability(
        selectedPayload,
        Boolean(selectedPayload?.streaming) || revisionActive
      ),
    [selectedPayload, revisionActive]
  );
  const shareHint = shareAvailability.available
    ? t("canvasApp.shareHint", "Share this Canvas snapshot")
    : shareAvailability.reason === "streaming"
      ? t(
          "canvasApp.shareWaitForRevision",
          "Wait for the Canvas update to finish"
        )
      : shareAvailability.reason === "local-url"
        ? t(
            "canvasApp.shareLocalUrlUnavailable",
            "Local URLs cannot be opened by other people"
          )
        : shareAvailability.reason === "source-too-large"
          ? t(
              "canvasApp.shareTooLarge",
              "This Canvas is too large for a share link"
            )
          : t("canvasApp.shareEmpty", "This Canvas has no shareable content");
  const handleShare = useCallback(() => {
    if (!selectedPayload || !shareAvailability.available) return;
    openCanvasShare(selectedPayload, cardTitle);
  }, [
    cardTitle,
    openCanvasShare,
    selectedPayload,
    shareAvailability.available,
  ]);

  // ── publish to SimulatorWorkstationTabHeader ─────────────────────────────

  const headerContent = useMemo(
    () =>
      appEvents.length > 0 && selectedPayload ? (
        <CanvasTabHeader
          tab={activeTab}
          onSetTab={handleSetTab}
          title={cardTitle}
          isStreaming={Boolean(selectedPayload.streaming) || revisionActive}
          onReload={handleReload}
          showCompare={compareEventIds.length === 2}
          designAvailable={designAvailable}
          designEnabled={designEnabled}
          onToggleDesign={handleToggleDesign}
          shareEnabled={shareAvailability.available}
          shareHint={shareHint}
          onShare={handleShare}
        />
      ) : null,
    [
      appEvents.length,
      selectedPayload,
      activeTab,
      cardTitle,
      handleSetTab,
      handleReload,
      compareEventIds.length,
      designAvailable,
      designEnabled,
      handleToggleDesign,
      revisionActive,
      shareAvailability.available,
      shareHint,
      handleShare,
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
            onSelect={handleSelect}
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
      handleSelect,
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
      ) : activeTab === "canvas" && selectedEvent ? (
        <>
          <CanvasIframe
            payload={selectedPayload}
            reloadKey={reloadKey}
            title={cardTitle}
            eventId={selectedEvent.id}
            sessionId={selectedEvent.sessionId}
            designEnabled={designEnabled}
          />
          {(selectedPayload.streaming || revisionDraft) && (
            <div
              className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 animate-pulse bg-primary-6/40"
              aria-hidden
            />
          )}
          {revisionDraft && (
            <div className="pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2">
              <CanvasRevisionProgress draft={revisionDraft} variant="overlay" />
            </div>
          )}
        </>
      ) : (
        /* source tab */
        <Suspense fallback={null}>
          <SessionReplayCodeMirrorViewer
            content={
              selectedPayload.mode === "url"
                ? (selectedPayload.url ?? "")
                : (selectedPayload.content ?? "")
            }
            language={selectedPayload.mode === "url" ? "plaintext" : "html"}
            filePath={
              selectedPayload.mode === "html" ? "canvas.html" : undefined
            }
          />
        </Suspense>
      )}
    </div>
  );

  return (
    <>
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
      <CanvasShareDialog
        state={canvasShareState}
        onClose={closeCanvasShare}
        onRetry={retryCanvasShare}
        onRetryShortLink={retryCanvasShareShortLink}
        onCopy={copyCanvasShare}
      />
    </>
  );
};

CanvasApp.displayName = "CanvasApp";
export default CanvasApp;
