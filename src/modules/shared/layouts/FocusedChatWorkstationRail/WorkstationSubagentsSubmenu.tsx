/**
 * WorkstationSubagentsSubmenu — second-level panel listing every subagent of
 * the active session, opened from the Subagents section's "load more" row.
 *
 * The panel is portaled to `document.body`, so it escapes both the wide
 * trail's scroll container and the compact menu's overflow clipping. Unlike
 * the shared right-preferring submenu geometry, it opens on the LEFT of its
 * list and reuses that list's width: the trail lives on the pane's right
 * edge, where every other trail popup (tooltips, the branch switcher) already
 * opens leftward. Vertical fitting still goes through `clampSubmenuTop`. The
 * compact menu keeps itself open while the pointer is inside this panel via
 * the Dropdown `additionalInsideRefs` contract.
 */
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import AnyIcon from "@src/components/AnyIcon";
import { DropdownItem, DropdownPanel } from "@src/components/Dropdown/exports";
import { subscribeToDropdownOutsideMouseDown } from "@src/components/Dropdown/outsideClick";
import {
  type SubmenuAnchor,
  clampSubmenuTop,
} from "@src/components/Dropdown/submenuLayout";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_PANEL,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";

import { RailItemStatus } from "./RailItemStatus";
import type {
  FocusedChatRailIcon,
  FocusedChatRailItem,
  FocusedChatRailSubagent,
} from "./types";

/**
 * Marks the container whose outer edge the submenu aligns to. Falls back to
 * the trigger row's own rect when no marked ancestor exists (the wide rail).
 */
export const WORKSTATION_SUBMENU_BOUNDS_ATTRIBUTE =
  "data-workstation-submenu-bounds";

/** Map a subagent lifecycle status onto the rail's CI-shaped status chip. */
export function resolveSubagentRowStatus(
  t: (key: string) => string,
  status: FocusedChatRailSubagent["status"]
): NonNullable<FocusedChatRailItem["status"]> {
  const label =
    status === "completed"
      ? t("common:git.rail.subagentCompleted")
      : status === "failed"
        ? t("common:git.rail.subagentFailed")
        : status === "running"
          ? t("common:git.rail.subagentRunning")
          : t("common:git.rail.subagentPending");
  return {
    label,
    state:
      status === "completed"
        ? "success"
        : status === "failed"
          ? "failure"
          : status === "running"
            ? "pending"
            : "checking",
    title: label,
    // The glyph alone marks the row; the localized label stays as the
    // tooltip so five finished rows don't repeat the same word five times.
    iconOnly: true,
  };
}

interface SubmenuState {
  anchor: SubmenuAnchor;
  /** Panel width — the parent list's own width, so both levels read as one. */
  width: number;
  triggerElement: HTMLElement;
}

/**
 * Open/close state and geometry for the submenu. The trigger row calls
 * `toggle` with itself; outside mousedowns close the panel, except on the
 * trigger row, whose own click handles the toggle.
 */
export function useWorkstationSubagentsSubmenu() {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<SubmenuState | null>(null);

  const close = useCallback(() => setState(null), []);

  const toggle = useCallback((trigger: HTMLElement) => {
    setState((current) => {
      if (current) return null;
      const triggerRect = trigger.getBoundingClientRect();
      const boundsRect =
        trigger
          .closest(`[${WORKSTATION_SUBMENU_BOUNDS_ATTRIBUTE}]`)
          ?.getBoundingClientRect() ?? null;
      const horizontalBounds = boundsRect ?? triggerRect;
      const width = horizontalBounds.width || DROPDOWN_WIDTHS.panelWidth;
      // Left of the list, mirroring every other popup on the pane's right
      // edge; only a list flush against the window's left edge flips right.
      const leftSideLeft =
        horizontalBounds.left - width - DROPDOWN_PANEL.submenuGap;
      const left =
        leftSideLeft < DROPDOWN_PANEL.viewportPadding
          ? horizontalBounds.right + DROPDOWN_PANEL.submenuGap
          : leftSideLeft;
      return {
        anchor: {
          left,
          opensUpward: false,
          parentTop: boundsRect?.top ?? DROPDOWN_PANEL.viewportPadding,
          parentBottom:
            boundsRect?.bottom ??
            window.innerHeight - DROPDOWN_PANEL.viewportPadding,
          // Pull up by the panel padding so the first submenu row lines up
          // with the row that opened it.
          top: Math.max(
            DROPDOWN_PANEL.viewportPadding,
            triggerRect.top - DROPDOWN_PANEL.padding
          ),
        },
        width,
        triggerElement: trigger,
      };
    });
  }, []);

  // The panel's real height is only known once it has rendered, so the
  // anchor's preferred top is corrected here rather than on open.
  useLayoutEffect(() => {
    if (!state || !panelRef.current) return;
    const { height: submenuHeight } = panelRef.current.getBoundingClientRect();
    const clampedTop = clampSubmenuTop({
      anchor: state.anchor,
      submenuHeight,
      viewportHeight: window.innerHeight,
    });
    if (clampedTop === state.anchor.top) return;
    setState((current) =>
      current
        ? { ...current, anchor: { ...current.anchor, top: clampedTop } }
        : current
    );
  }, [state]);

  useEffect(() => {
    if (!state) return;
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (panelRef.current?.contains(target)) return;
      if (state.triggerElement.contains(target)) return;
      close();
    };
    return subscribeToDropdownOutsideMouseDown(document, handleMouseDown);
  }, [close, state]);

  return {
    anchor: state?.anchor ?? null,
    close,
    panelRef,
    toggle,
    width: state?.width ?? DROPDOWN_WIDTHS.panelWidth,
  };
}

export function WorkstationSubagentsSubmenu({
  anchor,
  icon,
  onOpenSubagent,
  panelRef,
  subagents,
  width,
}: {
  anchor: SubmenuAnchor;
  /** Parent session's harness mark — the same one the preview rows carry. */
  icon: FocusedChatRailIcon;
  onOpenSubagent: (sessionId: string) => void;
  panelRef: React.RefObject<HTMLDivElement | null>;
  subagents: FocusedChatRailSubagent[];
  /** Same width as the list the panel opened from. */
  width: number;
}) {
  const { t } = useTranslation();

  return createPortal(
    <DropdownPanel
      ref={panelRef}
      className="fixed"
      width={width}
      style={{ top: anchor.top, left: anchor.left }}
      role="menu"
      aria-label={t("common:git.rail.subagents")}
      data-testid="workstation-trail-subagents-submenu"
    >
      <div className={DROPDOWN_CLASSES.itemsColumnPadded}>
        {subagents.map((subagent) => {
          const label = subagent.description || subagent.name;
          return (
            <DropdownItem
              key={subagent.sessionId}
              role="menuitem"
              icon={
                <AnyIcon
                  icon={icon}
                  size={DROPDOWN_ITEM.iconSize}
                  strokeWidth={1.75}
                />
              }
              suffix={
                <RailItemStatus
                  status={resolveSubagentRowStatus(t, subagent.status)}
                />
              }
              onClick={() => onOpenSubagent(subagent.sessionId)}
            >
              <span className="block min-w-0 truncate" title={label}>
                {label}
              </span>
            </DropdownItem>
          );
        })}
      </div>
    </DropdownPanel>,
    document.body
  );
}
