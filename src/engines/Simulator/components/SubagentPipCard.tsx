/**
 * SubagentPipCard — picture-in-picture split view
 *
 * Rendered when BackgroundTasksApp is minimized. Wraps the main simulator
 * content (top pane) and a horizontal strip of mini subagent cells (bottom
 * pane) in a vertically-resizable split. The split defaults to 50/50.
 *
 * The vertical drag handle uses HorizontalResizeHandle (row-resize cursor).
 * Subagent cells in the banner strip use equal flex widths and are not
 * horizontally resizable.
 *
 * Clicking the expand button (↗) on the banner header restores the full
 * BackgroundTasksApp panel.
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { EVENT_LOADING_SHIMMER_TEXT_CLASSES } from "@src/engines/ChatPanel/blocks/primitives";
import {
  ArrowDown01Icon,
  ArrowExpand01Icon,
  ArrowLeft01Icon,
  ArrowLeft02Icon,
  ArrowRight01Icon,
  ArrowShrink01Icon,
  HugeiconsIcon,
} from "@src/icons";
import BreadcrumbFileHeader from "@src/modules/shared/components/FileHeader/BreadcrumbFileHeader";
import { HorizontalResizeHandle } from "@src/scaffold/Resize";

import { useMultiSessionSimulatorEvents } from "../hooks/useMultiSessionSimulatorEvents";
import {
  type SubagentSession,
  isActiveAtTimestamp,
} from "../hooks/useSubagentSessions";
import { IndependentGridCell } from "./GridCell/IndependentGridCell";

// ── Constants ──────────────────────────────────────────────────────────────

const BANNER_MIN_HEIGHT = 80;
const BANNER_MAX_RATIO = 0.85;
const CELL_MIN_WIDTH = 120;
const SUBAGENT_STRIP_PAGE_SIZE = 2;
const SUBAGENT_GRID_PAGE_SIZE = 4;

// The spawning tool_call is filtered out of the main slider, so the last
// visible main-agent event before a subagent starts can be up to ~60 s
// earlier than the subagent's startedAtMs. We extend the look-back window
// so the cell highlights while the cursor is on those pre-spawn events.
const HIGHLIGHT_LEAD_MS = 90_000;

interface SubagentViewState {
  sessionKeySignature: string;
  pageIndex: number;
  gridExpanded: boolean;
  expandedSessionId: string | null;
}

export function advanceSubagentViewState(
  previous: SubagentViewState,
  sessionKeySignature: string
): SubagentViewState {
  if (previous.sessionKeySignature === sessionKeySignature) return previous;
  return {
    sessionKeySignature,
    pageIndex: 0,
    gridExpanded: false,
    expandedSessionId: null,
  };
}

// ── SubagentPipCard — vertically split main + banner strip ────────────────

interface SubagentPipCardProps {
  /** The main simulator content to show above the banner. */
  mainContent: React.ReactNode;
  activeSessions?: SubagentSession[];
  /** The main replay cursor's absolute epoch-ms timestamp, used for highlight window calculation. */
  mainCursorMs?: number | null;
  /**
   * True while the main session is live-following ("Following Agent").
   * Cells then live-tail their own event stream instead of time-syncing to
   * the main cursor — the parent's last-event timestamp lags behind a
   * streaming subagent (the parent is usually silent while delegating), so
   * synced mapping would pin every cell visibly behind its tail.
   */
  liveFollow?: boolean;
}

const AGENT_COLORS = [
  "from-blue-500",
  "from-purple-500",
  "from-green-500",
  "from-orange-500",
] as const;

const SubagentPipCard: React.FC<SubagentPipCardProps> = ({
  mainContent,
  activeSessions = [],
  mainCursorMs = null,
  liveFollow = false,
}) => {
  const { t } = useTranslation("sessions");
  const sessionKeySignature = useMemo(
    () =>
      activeSessions
        .map((sub) => sub.key)
        .sort()
        .join(","),
    [activeSessions]
  );
  const [viewState, setViewState] = useState<SubagentViewState>(() => ({
    sessionKeySignature,
    pageIndex: 0,
    gridExpanded: false,
    expandedSessionId: null,
  }));
  const nextViewState = advanceSubagentViewState(
    viewState,
    sessionKeySignature
  );
  if (nextViewState !== viewState) {
    setViewState(nextViewState);
  }
  const { pageIndex, gridExpanded, expandedSessionId } = nextViewState;
  const pageSize = gridExpanded
    ? SUBAGENT_GRID_PAGE_SIZE
    : SUBAGENT_STRIP_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(activeSessions.length / pageSize));
  const safePageIndex = Math.min(pageIndex, pageCount - 1);
  const pageStartIndex = safePageIndex * pageSize;
  const visibleSessions = useMemo(
    () => activeSessions.slice(pageStartIndex, pageStartIndex + pageSize),
    [activeSessions, pageSize, pageStartIndex]
  );
  const subagentEventsMap = useMultiSessionSimulatorEvents(visibleSessions);

  // "Monitoring N" prefers clips still running at the cursor, but completed
  // imported/live child clips still count when they are the visible monitor
  // rows; otherwise the header would say "Monitoring 0" while showing a cell.
  const runningCount = useMemo(() => {
    const running = activeSessions.filter(
      (sub) =>
        sub.endedAtMs === null ||
        (mainCursorMs != null && mainCursorMs < sub.endedAtMs)
    ).length;
    return running > 0 ? running : activeSessions.length;
  }, [activeSessions, mainCursorMs]);

  // ── Banner collapsed state ────────────────────────────────────────────────
  const [isBannerCollapsed, setIsBannerCollapsed] = useState(false);
  const bannerPaneRef = useRef<HTMLDivElement>(null);
  // Height of the banner pane before collapse — restored on expand.
  const bannerExpandedHeightRef = useRef<number | null>(null);
  // Ref to prevent stacking animation listeners on rapid clicks.
  const bannerAnimatingRef = useRef(false);

  const BANNER_HEADER_H = 40; // px — matches h-10

  const toggleBannerCollapsed = useCallback(() => {
    const el = bannerPaneRef.current;
    const topEl = topPaneRef.current;
    if (!el || bannerAnimatingRef.current) return;

    bannerAnimatingRef.current = true;
    const collapsing = !isBannerCollapsed;

    if (collapsing) {
      // Snapshot heights.
      const bannerH = el.offsetHeight;
      const topH = topEl?.offsetHeight ?? 0;
      bannerExpandedHeightRef.current = bannerH;

      // Fix top pane height so it doesn't jump during banner animation.
      if (topEl) topEl.style.height = `${topH}px`;
      // Fix banner pane height then animate to header-only height.
      el.style.height = `${bannerH}px`;
      el.style.flex = "none";

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          el.style.height = `${BANNER_HEADER_H}px`;
          if (topEl)
            topEl.style.height = `${topH + bannerH - BANNER_HEADER_H}px`;
        });
      });

      const onEnd = () => {
        setIsBannerCollapsed(true);
        bannerAnimatingRef.current = false;
        el.removeEventListener("transitionend", onEnd);
      };
      el.addEventListener("transitionend", onEnd);
    } else {
      // Restore to saved expanded height.
      const targetH = bannerExpandedHeightRef.current ?? 200;
      const topH = topEl?.offsetHeight ?? 0;

      el.style.height = `${BANNER_HEADER_H}px`;
      el.style.flex = "none";
      setIsBannerCollapsed(false);

      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          el.style.height = `${targetH}px`;
          if (topEl)
            topEl.style.height = `${topH - targetH + BANNER_HEADER_H}px`;
        });
      });

      const onEnd = () => {
        // Release explicit heights so flex/resize can take over again.
        el.style.height = "";
        el.style.flex = "";
        // top pane keeps its current inline height; the next resize drag will reset it
        bannerAnimatingRef.current = false;
        el.removeEventListener("transitionend", onEnd);
      };
      el.addEventListener("transitionend", onEnd);
    }
  }, [isBannerCollapsed]);

  // ── Expand state — which cell (by sessionId) is currently fullscreen ──────
  const isAnyExpanded = expandedSessionId !== null || gridExpanded;

  const expandBannerImmediately = useCallback(() => {
    const bannerPane = bannerPaneRef.current;
    if (bannerPane) {
      bannerPane.style.height = "";
      bannerPane.style.flex = "";
    }
    bannerAnimatingRef.current = false;
    setIsBannerCollapsed(false);
  }, []);

  const handleExpand = useCallback(
    (sessionId: string) => {
      const nextExpandedSessionId =
        expandedSessionId === sessionId ? null : sessionId;
      if (nextExpandedSessionId) expandBannerImmediately();
      setViewState((current) => ({
        ...current,
        gridExpanded: false,
        expandedSessionId: nextExpandedSessionId,
      }));
    },
    [expandBannerImmediately, expandedSessionId]
  );
  const handlePreviousPage = useCallback(() => {
    setViewState((current) => ({
      ...current,
      expandedSessionId: null,
      pageIndex: Math.max(0, current.pageIndex - 1),
    }));
  }, []);
  const handleNextPage = useCallback(() => {
    setViewState((current) => ({
      ...current,
      expandedSessionId: null,
      pageIndex: Math.min(pageCount - 1, current.pageIndex + 1),
    }));
  }, [pageCount]);

  const handleToggleGridExpanded = useCallback(() => {
    const nextGridExpanded = !gridExpanded;
    if (nextGridExpanded) expandBannerImmediately();
    setViewState((current) => ({
      ...current,
      expandedSessionId: null,
      gridExpanded: nextGridExpanded,
    }));
  }, [expandBannerImmediately, gridExpanded]);
  // ── Vertical split (top / bottom) ──────────────────────────────────────
  const containerRef = useRef<HTMLDivElement>(null);
  const topPaneRef = useRef<HTMLDivElement>(null);
  const isVResizingRef = useRef(false);
  const hasDraggedVRef = useRef(false);
  const vRafRef = useRef<number>(0);
  const pendingTopHRef = useRef<number>(0);
  const vDragCleanupRef = useRef<(() => void) | null>(null);

  const [topHeight, setTopHeight] = useState<number | null>(null);

  const handleBannerChevronClick = useCallback(() => {
    if (isAnyExpanded) {
      setViewState((current) => ({
        ...current,
        expandedSessionId: null,
        gridExpanded: false,
      }));
      setIsBannerCollapsed(true);
      const containerHeight =
        containerRef.current?.getBoundingClientRect().height;
      if (containerHeight && containerHeight > BANNER_HEADER_H) {
        setTopHeight(
          Math.max(BANNER_MIN_HEIGHT, containerHeight - BANNER_HEADER_H)
        );
      }
      const bannerPane = bannerPaneRef.current;
      if (bannerPane) {
        bannerPane.style.height = `${BANNER_HEADER_H}px`;
        bannerPane.style.flex = "none";
      }
      bannerAnimatingRef.current = false;
      return;
    }

    toggleBannerCollapsed();
  }, [isAnyExpanded, toggleBannerCollapsed]);

  // Use ResizeObserver to reliably get the container height once it is
  // laid out (avoids the rAF-returns-0 race when the container is not
  // yet painted on the first effect run).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const init = (h: number) => {
      if (h > 0)
        setTopHeight((prev) => (prev === null ? Math.round(h / 2) : prev));
    };

    // Immediate attempt — works if the element already has a size.
    init(el.getBoundingClientRect().height);

    // Fallback via ResizeObserver for deferred layout.
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) init(entry.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const getVConstraints = useCallback(() => {
    const h = containerRef.current?.getBoundingClientRect().height ?? 400;
    return { min: BANNER_MIN_HEIGHT, max: Math.round(h * BANNER_MAX_RATIO) };
  }, []);

  const handleVMouseDown = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      if (isVResizingRef.current) return;
      isVResizingRef.current = true;
      hasDraggedVRef.current = false;

      const startY = event.clientY;
      const startH =
        topPaneRef.current?.getBoundingClientRect().height ?? topHeight ?? 200;
      pendingTopHRef.current = startH;

      const onMove = (mv: MouseEvent) => {
        if (!hasDraggedVRef.current) {
          hasDraggedVRef.current = true;
          document.body.style.cursor = "row-resize";
          document.body.style.userSelect = "none";
        }
        const { min, max } = getVConstraints();
        const newH = Math.max(min, Math.min(max, startH + mv.clientY - startY));
        pendingTopHRef.current = newH;
        if (vRafRef.current) cancelAnimationFrame(vRafRef.current);
        vRafRef.current = requestAnimationFrame(() => {
          if (topPaneRef.current) topPaneRef.current.style.height = `${newH}px`;
        });
      };

      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        if (hasDraggedVRef.current) {
          if (vRafRef.current) cancelAnimationFrame(vRafRef.current);
          document.body.style.cursor = "";
          document.body.style.userSelect = "";
          // Don't clear inline style before setState — let React's re-render
          // overwrite it directly to avoid a one-frame flash back to the old height.
          setTopHeight(pendingTopHRef.current);
        }
        isVResizingRef.current = false;
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      vDragCleanupRef.current = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        isVResizingRef.current = false;
      };
    },
    [topHeight, getVConstraints]
  );

  useEffect(() => () => vDragCleanupRef.current?.(), []);

  // ── Child entries ───────────────────────────────────────────────────────
  const childEntries = useMemo(
    () =>
      visibleSessions.map((sub, index) => ({
        key: sub.key,
        sessionId: sub.sessionId,
        name: sub.name,
        description: sub.description,
        sessionType: sub.sessionType,
        startedAtMs: sub.startedAtMs,
        endedAtMs: sub.endedAtMs,
        events: subagentEventsMap.get(sub.sessionId) ?? [],
        color: AGENT_COLORS[(pageStartIndex + index) % AGENT_COLORS.length],
        // Keep the full SubagentSession for isActiveAtTimestamp calls.
        sub,
        // Stable callback so IndependentGridCell memo comparison doesn't
        // create a new function identity on every render.
        onExpand: () => handleExpand(sub.sessionId),
      })),
    [visibleSessions, subagentEventsMap, handleExpand, pageStartIndex]
  );

  return (
    <div
      ref={containerRef}
      className="flex h-full w-full flex-col overflow-hidden"
    >
      {/* Top pane — main simulator content.
          Hidden when a subagent cell is expanded to fullscreen.
          When the banner is collapsed, flex-1 so it fills all remaining space. */}
      {!isAnyExpanded && (
        <>
          <div
            ref={topPaneRef}
            className={`min-h-0 overflow-hidden ${topHeight !== null ? "shrink-0" : "flex-1"}`}
            style={topHeight !== null ? { height: topHeight } : undefined}
          >
            {mainContent}
          </div>
          {!isBannerCollapsed && (
            <HorizontalResizeHandle onMouseDown={handleVMouseDown} />
          )}
        </>
      )}

      {/* Bottom pane — subagent banner. Height is JS-animated on collapse/expand. */}
      <div
        ref={bannerPaneRef}
        className={`flex flex-col overflow-hidden transition-[height] duration-300 ease-in-out ${
          isAnyExpanded
            ? "flex-1"
            : isBannerCollapsed
              ? "shrink-0 border-t border-border-2"
              : "min-h-0 flex-1"
        }`}
      >
        {/* Banner header — task count + collapse toggle */}
        <div className="flex h-10 shrink-0 items-center gap-2 pr-2 pl-1.5">
          <Button
            htmlType="button"
            variant="tertiary"
            size="small"
            iconOnly
            onClick={handleBannerChevronClick}
            title={
              isBannerCollapsed
                ? t("simulator.gridCell.expand")
                : t("simulator.gridCell.collapse")
            }
            icon={
              isAnyExpanded ? (
                <HugeiconsIcon
                  icon={ArrowLeft02Icon}
                  data-icon="arrow-left"
                  size={14}
                  strokeWidth={2}
                />
              ) : (
                <HugeiconsIcon
                  icon={ArrowDown01Icon}
                  data-icon="chevron-down"
                  size={14}
                  strokeWidth={2}
                  className="transition-transform duration-300 ease-in-out"
                  style={{
                    transform: isBannerCollapsed
                      ? "rotate(-90deg)"
                      : "rotate(0deg)",
                  }}
                />
              )
            }
          />
          <span className="pointer-events-none h-4 w-px shrink-0 bg-border-2" />
          <BreadcrumbFileHeader
            filePath={t("simulator.multiTask.monitoringProgress", {
              count: runningCount,
            })}
            disableNavigation
            plainTitle
            className="flex-none!"
            lastSegmentClassName={
              runningCount > 0
                ? `font-bold ${EVENT_LOADING_SHIMMER_TEXT_CLASSES}`
                : ""
            }
          />
          <div className="ml-auto flex shrink-0 items-center gap-px">
            {!isBannerCollapsed && pageCount > 1 && (
              <>
                <Button
                  htmlType="button"
                  variant="tertiary"
                  size="small"
                  iconOnly
                  disabled={safePageIndex <= 0}
                  onClick={handlePreviousPage}
                  title={t("common:actions.previous")}
                  icon={
                    <HugeiconsIcon
                      icon={ArrowLeft01Icon}
                      data-icon="chevron-left"
                      size={16}
                      strokeWidth={1.75}
                    />
                  }
                />
                <Button
                  htmlType="button"
                  variant="tertiary"
                  size="small"
                  iconOnly
                  disabled={safePageIndex >= pageCount - 1}
                  onClick={handleNextPage}
                  title={t("common:actions.next")}
                  icon={
                    <HugeiconsIcon
                      icon={ArrowRight01Icon}
                      data-icon="chevron-right"
                      size={16}
                      strokeWidth={1.75}
                    />
                  }
                />
              </>
            )}
            <Button
              htmlType="button"
              variant="tertiary"
              size="small"
              iconOnly
              onClick={handleToggleGridExpanded}
              title={
                gridExpanded
                  ? t("simulator.gridCell.collapse")
                  : t("simulator.gridCell.expand")
              }
              icon={
                gridExpanded ? (
                  <HugeiconsIcon
                    icon={ArrowShrink01Icon}
                    data-icon="minimize-2"
                    size={14}
                    strokeWidth={1.75}
                  />
                ) : (
                  <HugeiconsIcon
                    icon={ArrowExpand01Icon}
                    data-icon="maximize-2"
                    size={14}
                    strokeWidth={1.75}
                  />
                )
              }
            />
          </div>
        </div>

        {/* Horizontal strip */}
        <div className="min-h-0 flex-1 px-2 pb-2">
          <div
            className={
              gridExpanded
                ? "grid h-full grid-cols-2 grid-rows-2 gap-1 overflow-hidden py-1"
                : "flex h-full gap-1 overflow-x-auto overflow-y-hidden py-1"
            }
          >
            {childEntries.map((entry, index) => {
              const isExpanded = expandedSessionId === entry.sessionId;

              // In single-cell expanded mode, only render the expanded cell.
              if (expandedSessionId && !isExpanded) return null;

              const adjustedStart = entry.sub.startedAtMs - HIGHLIGHT_LEAD_MS;
              const inWindow =
                mainCursorMs != null &&
                isActiveAtTimestamp(
                  { ...entry.sub, startedAtMs: adjustedStart },
                  mainCursorMs
                );
              const isHighlighted = inWindow;

              return (
                <React.Fragment key={entry.key}>
                  <div
                    className="relative flex flex-col overflow-hidden rounded-lg border-2 border-border-2/60 transition-all duration-300"
                    style={
                      gridExpanded
                        ? undefined
                        : isExpanded
                          ? { flex: "1 1 0" }
                          : { flex: "1 1 0", minWidth: CELL_MIN_WIDTH }
                    }
                  >
                    <IndependentGridCell
                      index={index}
                      color={entry.color}
                      title={entry.name}
                      subtitle={entry.description || undefined}
                      events={entry.events}
                      specs={[]}
                      sessionType={entry.sessionType}
                      threadId={entry.sessionId}
                      externalCursorMs={liveFollow ? null : mainCursorMs}
                      isHighlighted={isHighlighted}
                      isExpanded={isExpanded}
                      onExpand={entry.onExpand}
                      isSessionLive={entry.endedAtMs === null}
                    />
                  </div>
                </React.Fragment>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};

SubagentPipCard.displayName = "SubagentPipCard";
export { SubagentPipCard };
