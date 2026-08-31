import {
  type ButtonHTMLAttributes,
  type FC,
  type HTMLAttributes,
  type ReactNode,
  createElement,
} from "react";

import { DROPDOWN_PANEL } from "@src/components/Dropdown/tokens";
import {
  BUTTON_SIZE,
  EDITOR_TAB_CANVAS_BG_CLASS,
  TAB_BAR_TRAILING_CLUSTER_CLASS,
  WORKSTATION_TRAIL_CONTENT,
} from "@src/config/workstation/tokens";

export interface WorkstationTrailSurfaceProps extends HTMLAttributes<HTMLElement> {
  as?: "aside" | "div";
  children?: ReactNode;
}

export const WORKSTATION_TRAIL_SURFACE_CLASS = `max-h-full w-full flex-col overflow-hidden rounded-xl border border-border-1 p-1 ${DROPDOWN_PANEL.shadowSoftClass} ${EDITOR_TAB_CANVAS_BG_CLASS}`;
export const WORKSTATION_TRAIL_WIDTH = {
  expandedPx: 256,
  /**
   * Expanded focused-chat column. Its width comes from the
   * `--workstation-trail-track-width` custom property the trail sets inline
   * (see `FocusedChatWorkstationRail/trailWidth.ts`) — the column has to
   * contain both the trail surface and the wider docked terminal. The
   * container query keeps it at zero below 1100px, where the compact
   * dropdown takes over.
   */
  resizableResponsiveClass:
    "@[1100px]/focusedchat:w-[var(--workstation-trail-track-width)]",
  /** Trail surface's own width inside that column. */
  surfaceResponsiveClass:
    "@[1100px]/focusedchat:w-[var(--workstation-trail-width)]",
  collapsedResponsiveClass: "@[1100px]/focusedchat:w-11",
} as const;
export const WORKSTATION_TRAIL_RAIL_PADDING_CLASS = "px-1 pb-1 pt-2";
export const FOCUSED_CHAT_WORKSTATION_TRAIL_RAIL_PADDING_CLASS =
  "@[1100px]/focusedchat:px-1 @[1100px]/focusedchat:pb-1 @[1100px]/focusedchat:pt-2";
export const WORKSTATION_TRAIL_ICON_BUTTON_CLASS = `flex ${BUTTON_SIZE.sm} shrink-0 items-center justify-center rounded-lg text-text-1 transition-colors hover:bg-fill-2`;

export interface WorkstationTrailHeaderProps {
  actions?: ReactNode;
  collapsed?: boolean;
  /** Omit the body gap when the header is the only visible row. */
  standalone?: boolean;
  title: ReactNode;
  titleActions?: ReactNode;
  /** Inline content between the title controls and trailing actions. */
  children?: ReactNode;
}

/** Exact title row used by the focused-chat Workstation environment trail. */
export const WorkstationTrailHeader: FC<WorkstationTrailHeaderProps> = ({
  actions,
  collapsed = false,
  standalone = false,
  title,
  titleActions,
  children,
}) => (
  <div
    // Three right pixels keep a 20px button's center aligned with the tab
    // bar: 3 + 20 / 2 = the original 26px control's 13px offset.
    className={`flex shrink-0 items-center gap-px ${standalone ? "" : "mb-1"} ${
      collapsed ? "h-7 justify-center" : "h-6 justify-between pl-1 pr-[3px]"
    }`}
  >
    {!collapsed ? (
      <div className="flex min-w-0 flex-1 items-center gap-px">
        {title != null ? (
          <span
            className={`min-w-0 truncate px-1 text-[11px] font-medium uppercase tracking-wide text-text-3 ${children ? "max-w-20 shrink-0" : ""}`}
          >
            {title}
          </span>
        ) : null}
        {titleActions}
        {children}
      </div>
    ) : null}
    {actions ? (
      <div className={TAB_BAR_TRAILING_CLUSTER_CLASS}>{actions}</div>
    ) : null}
  </div>
);

export const WorkstationTrailIconButton: FC<
  ButtonHTMLAttributes<HTMLButtonElement>
> = ({ children, className = "", type = "button", ...buttonProps }) => (
  <button
    {...buttonProps}
    type={type}
    className={`${WORKSTATION_TRAIL_ICON_BUTTON_CLASS} ${className}`.trim()}
  >
    {children}
  </button>
);

export interface WorkstationTrailSectionProps {
  title: ReactNode;
  /** Control aligned to the right end of the label row (e.g. a picker trigger). */
  action?: ReactNode;
  hideTitle?: boolean;
  dataTestId?: string;
  children?: ReactNode;
}

/**
 * Labelled section for trail property rails (Work Item properties, PR detail
 * sidebar): the shared uppercase section label, an optional right-end action,
 * then the section content.
 */
export const WorkstationTrailSection: FC<WorkstationTrailSectionProps> = ({
  title,
  action,
  hideTitle = false,
  dataTestId,
  children,
}) => {
  const label = !hideTitle ? (
    <h3 className={WORKSTATION_TRAIL_CONTENT.sectionLabel}>{title}</h3>
  ) : null;

  return (
    <section
      data-testid={dataTestId}
      className={WORKSTATION_TRAIL_CONTENT.section}
    >
      {/* Same row geometry as WorkstationTrailHeader, so a section action lands
          on the exact spot the trail's own collapse control occupies. Rendered
          unconditionally to keep every section label on one baseline. */}
      <div className="flex h-6 items-center justify-between gap-2 pr-[3px]">
        {label}
        {action}
      </div>
      {children}
    </section>
  );
};

/** Muted empty-state line inside a trail section. */
export const WorkstationTrailEmptyText: FC<{ children?: ReactNode }> = ({
  children,
}) => <div className="px-2 text-[12px] text-text-3">{children}</div>;

/** Shared scroll container directly below a Workstation trail header. */
export const WorkstationTrailBody: FC<HTMLAttributes<HTMLDivElement>> = ({
  children,
  className = "",
  ...divProps
}) => (
  <div
    {...divProps}
    className={`min-h-0 overflow-y-auto scrollbar-hide ${className}`.trim()}
  >
    {children}
  </div>
);

/** Exact surface used by the focused-chat Workstation environment trail. */
const WorkstationTrailSurface: FC<WorkstationTrailSurfaceProps> = ({
  as = "div",
  children,
  className = "",
  ...elementProps
}) =>
  createElement(
    as,
    {
      ...elementProps,
      className: `${WORKSTATION_TRAIL_SURFACE_CLASS} ${className}`.trim(),
    },
    children
  );

WorkstationTrailSurface.displayName = "WorkstationTrailSurface";
WorkstationTrailHeader.displayName = "WorkstationTrailHeader";
WorkstationTrailIconButton.displayName = "WorkstationTrailIconButton";
WorkstationTrailBody.displayName = "WorkstationTrailBody";
WorkstationTrailSection.displayName = "WorkstationTrailSection";
WorkstationTrailEmptyText.displayName = "WorkstationTrailEmptyText";

export default WorkstationTrailSurface;
