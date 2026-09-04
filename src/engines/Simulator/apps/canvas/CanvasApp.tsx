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
import React, { Suspense, lazy, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";
import { SIMULATOR_PRIMARY_SIDEBAR } from "@src/config/simulatorPrimarySidebar";
import CanvasRevisionProgress from "@src/engines/ChatPanel/blocks/CanvasInlineCard/CanvasRevisionProgress";
import { isCanvasRevisionDraftRelevant } from "@src/engines/ChatPanel/blocks/CanvasInlineCard/canvasRevisionProgressState";
import { useCanvasRevisionDraftForSession } from "@src/engines/SessionCore";
import {
  CanvasShareDialog,
  getCanvasShareAvailability,
  useCanvasShareDialog,
} from "@src/features/CanvasShare";
import { usePublishWorkstationTabHeader } from "@src/hooks/tabHost/useWorkstationTabHeader";
import {
  SimulatorReplayChrome,
  WorkStationShell,
  buildPrimarySidebarConfig,
} from "@src/modules/WorkStation/shared";
import { canvasPreviewAtom } from "@src/store/session/canvasPreviewAtom";
import {
  simulatorPrimarySidebarCollapsedAtom,
  simulatorPrimarySidebarPositionAtom,
  simulatorPrimarySidebarWidthAtom,
  simulatorPrimarySidebarWidthPersistAtom,
} from "@src/store/ui/simulatorAtom";

import type { SimulatorAppProps } from "../core/types";
import { useSimulatorAppState } from "../core/useSimulatorAppState";
import CanvasIframe from "./CanvasIframe";
import CanvasSidebar from "./CanvasSidebar";
import CanvasTabHeader from "./CanvasTabHeader";
import DiffView from "./DiffView";
import { CANVAS_APP_CONFIG } from "./canvasConfig";
import {
  type CanvasViewTab,
  createCanvasInteractionState,
  reconcileCanvasInteractionState,
  reloadCanvas,
  selectCanvasEvent,
  setCanvasViewTab,
  toggleCanvasComparison,
} from "./canvasInteractionState";
import { extractPayload, getDefaultTitle } from "./canvasPayload";
import { projectLatestCanvasEvents } from "./canvasRevisionProjection";

// Lazy: the "source" tab is the only CodeMirror user in the canvas app.
const SessionReplayCodeMirrorViewer = lazy(() =>
  import("@src/modules/WorkStation/CodeEditor/SessionReplay/CodePanel/SessionReplayCodeMirrorViewer").then(
    (mod) => ({ default: mod.SessionReplayCodeMirrorViewer })
  )
);

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
            <div className="pointer-events-none absolute top-3 left-1/2 z-20 -translate-x-1/2">
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
