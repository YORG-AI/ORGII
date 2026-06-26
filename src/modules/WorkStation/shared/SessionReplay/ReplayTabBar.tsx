/**
 * ReplayTabBar
 *
 * Generic read-only tab strip rendered above the main pane of a simulator's
 * session-replay view. Visually mirrors the My Station app tab bars (same
 * TAB_BAR_HEIGHT, transparent strip, bg-fill-2 active tab pill, no underline, no DnD,
 * no close/split-view chrome) — this is the replay equivalent.
 *
 * Domain-agnostic: each tab carries its own `label`, `title`, and `icon` (or
 * a `kind` string which the renderer maps to a sensible default icon for a
 * handful of well-known kinds). Callers decide what a tab represents and
 * how clicks are dispatched.
 *
 * Pair with helpers in `replayTabHelpers.ts` for the common case of
 * "merge several op lists newest-first, dedupe, cap at N, keep active":
 *
 *   const tabs = capNewestWithActive(
 *     mergeNewestFirstByTimestamp(sources),
 *     activeEventId,
 *     MAX_REPLAY_TABS
 *   );
 */
import { FileText, Globe, Search, Terminal, Wrench } from "lucide-react";
import React, { Fragment, memo, useEffect, useRef } from "react";

import FileTypeIcon from "@src/components/FileTypeIcon";
import { SURFACE_TOKENS } from "@src/config/surfaceTokens";
import { EVENT_LOADING_SHIMMER_TEXT_CLASSES } from "@src/engines/ChatPanel/blocks/primitives";

import { NoDragRegion } from "../NoDragRegion";
import { WorkStationTabPillSurface } from "../TabBar/components";
import {
  TAB_BAR_HEIGHT,
  TAB_PAIR_SEPARATOR_SLOT_CLASS,
} from "../TabBar/config";
import { TAB_BAR_TRAILING_EDGE_CLASS } from "../tokens";

/**
 * Well-known tab kinds that get a built-in fallback icon. Any other kind
 * string is accepted as long as the caller supplies `icon` on the tab.
 * The renderer never *requires* a specific kind; `kind` is just a hint.
 */
export type KnownReplayTabKind =
  | "file"
  | "explore"
  | "terminal"
  | "tool"
  | "browser"
  | "web_search"
  | "web_fetch"
  | "internal_browser";

export interface ReplayTab {
  /** Stable ID — typically the underlying session event / entry id. */
  eventId: string;
  /**
   * Hint for default icon selection when `icon` is absent. Accepts any string
   * so domain-specific kinds (e.g. Browser's entry categories) don't need to
   * be added to the shared union, while still giving autocomplete for the
   * well-known ones.
   */
  // The `string & Record<never, never>` branch preserves the literal
  // autocomplete while widening to any string — equivalent to the
  // `string & {}` pattern but avoids the `ban-types` rule.
  kind: KnownReplayTabKind | (string & Record<never, never>);
  /** Visible short label shown next to the icon. */
  label: string;
  /** Native tooltip on hover (full path / URL / command / etc.). */
  title: string;
  /**
   * Pre-rendered icon. Required when `kind` is not in `KnownReplayTabKind`;
   * strongly recommended otherwise since consumers usually have a richer
   * icon than the built-in fallback (e.g. `FaviconIcon` for fetches,
   * `sidebarToolIcon(functionName)` for tools).
   */
  icon?: React.ReactNode;
  /**
   * When true, the tab label is rendered with the chat-block loading shimmer
   * so the user can see at a glance that the underlying tool call is still
   * running. Mirrors the shimmer applied to `TerminalBlock`/`CodeBlock` headers
   * in `ChatPanel`.
   */
  isLoading?: boolean;
}

export interface ReplayTabBarProps {
  tabs: ReplayTab[];
  activeEventId: string | null;
  onTabClick: (eventId: string) => void;
  onTabDoubleClick?: (eventId: string) => void;
  /**
   * Optional chrome rendered flush-left before the tab strip — mirrors My
   * Station's TabBar `leadingSlot`. In the simulator this is where the
   * app-switcher chip + primary-sidebar toggle live, so the tab strip is
   * the single top chrome row.
   */
  leadingSlot?: React.ReactNode;
  /**
   * Optional chrome rendered flush-right after the tab strip — mirror of My
   * Station's TabBar `trailingSlot`. Reserved for future right-aligned
   * controls (bottom-panel toggle, etc.).
   */
  trailingSlot?: React.ReactNode;
  surfaceClassName?: string;
}

const ICON_SIZE = 14;

function defaultIconForKind(
  kind: ReplayTab["kind"],
  label: string,
  isActive: boolean
): React.ReactNode {
  const lucideClass = isActive
    ? "shrink-0 text-primary-6"
    : "shrink-0 text-text-3";
  switch (kind) {
    case "file":
      return <FileTypeIcon fileName={label} size="small" />;
    case "explore":
    case "web_search":
      return <Search size={ICON_SIZE} className={lucideClass} />;
    case "terminal":
      return <Terminal size={ICON_SIZE} className={lucideClass} />;
    case "tool":
      return <Wrench size={ICON_SIZE} className={lucideClass} />;
    case "browser":
    case "internal_browser":
      return <Globe size={ICON_SIZE} className={lucideClass} />;
    case "web_fetch":
      return <FileText size={ICON_SIZE} className={lucideClass} />;
    default:
      // Generic text-document glyph for unknown kinds — callers are expected
      // to supply `icon` in this case, so this is just a safety net.
      return <FileText size={ICON_SIZE} className={lucideClass} />;
  }
}

interface TabItemProps {
  tab: ReplayTab;
  isActive: boolean;
  onClick: () => void;
  onDoubleClick?: () => void;
}

const TabItem: React.FC<TabItemProps> = ({
  tab,
  isActive,
  onClick,
  onDoubleClick,
}) => {
  const icon = tab.icon ?? defaultIconForKind(tab.kind, tab.label, isActive);
  // File-type icons are full-colour SVG assets — don't override their fill/stroke.
  // Lucide icons and custom ReactNode icons should still be tinted by the active state.
  const isFileKind = tab.kind === "file";
  const iconClass = isFileKind
    ? ""
    : isActive
      ? "[&_svg]:!text-primary-6 [&_svg]:!stroke-primary-6"
      : "[&_svg]:text-text-3 [&_svg]:stroke-current";
  return (
    <WorkStationTabPillSurface
      as="button"
      role="tab"
      aria-selected={isActive}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      title={tab.title}
      data-event-id={tab.eventId}
      data-testid={`replay-tab-${tab.kind}`}
      isActive={isActive}
    >
      <span
        className={`inline-flex shrink-0 items-center${iconClass ? ` ${iconClass}` : ""}`}
      >
        {icon}
      </span>
      <span
        className={`max-w-[160px] truncate text-[13px] ${
          tab.isLoading ? `font-bold ${EVENT_LOADING_SHIMMER_TEXT_CLASSES}` : ""
        }`}
      >
        {tab.label}
      </span>
    </WorkStationTabPillSurface>
  );
};

const ReplayTabBarComponent: React.FC<ReplayTabBarProps> = ({
  tabs,
  activeEventId,
  onTabClick,
  onTabDoubleClick,
  leadingSlot,
  trailingSlot,
  surfaceClassName = SURFACE_TOKENS.surface,
}) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!activeEventId) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    const frameId = requestAnimationFrame(() => {
      const el = container.querySelector<HTMLElement>(
        `[data-event-id="${CSS.escape(activeEventId)}"]`
      );
      if (!el) return;

      const containerRect = container.getBoundingClientRect();
      const elRect = el.getBoundingClientRect();
      const elLeft = elRect.left - containerRect.left + container.scrollLeft;
      const elRight = elLeft + el.offsetWidth;
      const visibleLeft = container.scrollLeft + 4;
      const visibleRight = container.scrollLeft + container.clientWidth - 4;

      if (elLeft < visibleLeft || elRight > visibleRight) {
        container.scrollLeft = Math.max(0, elLeft - 4);
      }
    });

    return () => cancelAnimationFrame(frameId);
  }, [activeEventId]);

  const hasTabs = tabs.length > 0;
  // The bar still renders when there are no tabs as long as there's slot
  // chrome to show — matches My Station's TabBar so the app-switcher row
  // never "blinks away" during empty states (e.g. Browser with no entries
  // yet but we still need the title chip visible).
  if (!hasTabs && !leadingSlot && !trailingSlot) return null;

  return (
    <>
      <div
        className={`relative flex shrink-0 items-center overflow-hidden ${surfaceClassName}`}
        data-tauri-drag-region
        style={
          {
            height: `${TAB_BAR_HEIGHT}px`,
            WebkitAppRegion: "drag",
          } as React.CSSProperties
        }
      >
        {leadingSlot && (
          <NoDragRegion className="relative flex h-full shrink-0 items-center">
            {leadingSlot}
          </NoDragRegion>
        )}
        <NoDragRegion
          ref={scrollContainerRef}
          className="relative flex h-full min-w-0 flex-1 items-center overflow-x-auto overflow-y-hidden scrollbar-hide"
        >
          <div role="tablist" className="flex h-full items-center">
            {tabs.map((tab, i) => {
              const next = tabs[i + 1];
              const separatorVisible =
                !!next &&
                tab.eventId !== activeEventId &&
                next.eventId !== activeEventId;
              return (
                <Fragment key={tab.eventId}>
                  <TabItem
                    tab={tab}
                    isActive={tab.eventId === activeEventId}
                    onClick={() => onTabClick(tab.eventId)}
                    onDoubleClick={
                      onTabDoubleClick
                        ? () => onTabDoubleClick(tab.eventId)
                        : undefined
                    }
                  />
                  {next && (
                    <span
                      className={`${TAB_PAIR_SEPARATOR_SLOT_CLASS} ${
                        separatorVisible ? "bg-border-2" : "bg-transparent"
                      }`}
                      aria-hidden
                    />
                  )}
                </Fragment>
              );
            })}
          </div>
        </NoDragRegion>
        {trailingSlot && (
          <NoDragRegion className={TAB_BAR_TRAILING_EDGE_CLASS}>
            {trailingSlot}
          </NoDragRegion>
        )}
      </div>
    </>
  );
};

export const ReplayTabBar = memo(ReplayTabBarComponent);
ReplayTabBar.displayName = "ReplayTabBar";

export default ReplayTabBar;
