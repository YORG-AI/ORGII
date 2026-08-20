import {
  type ButtonHTMLAttributes,
  type FC,
  type HTMLAttributes,
  type ReactNode,
  createElement,
} from "react";

import { DROPDOWN_PANEL } from "@src/components/Dropdown/tokens";
import { EDITOR_TAB_CANVAS_BG_CLASS } from "@src/config/workstation/tokens";

export interface WorkstationTrailSurfaceProps extends HTMLAttributes<HTMLElement> {
  as?: "aside" | "div";
  children?: ReactNode;
}

export const WORKSTATION_TRAIL_SURFACE_CLASS = `max-h-full w-full flex-col overflow-hidden rounded-xl border border-border-1 p-1 ${DROPDOWN_PANEL.shadowClass} ${EDITOR_TAB_CANVAS_BG_CLASS}`;
export const WORKSTATION_TRAIL_WIDTH = {
  expandedPx: 256,
  expandedResponsiveClass: "@[1100px]/focusedchat:w-64",
  collapsedResponsiveClass: "@[1100px]/focusedchat:w-11",
} as const;
export const WORKSTATION_TRAIL_RAIL_PADDING_CLASS = "px-1 pb-1 pt-2";
export const FOCUSED_CHAT_WORKSTATION_TRAIL_RAIL_PADDING_CLASS =
  "@[1100px]/focusedchat:px-1 @[1100px]/focusedchat:pb-1 @[1100px]/focusedchat:pt-2";
export const WORKSTATION_TRAIL_ICON_BUTTON_CLASS =
  "flex h-[26px] w-[26px] items-center justify-center rounded-lg text-text-1 transition-colors hover:bg-fill-2";

export interface WorkstationTrailHeaderProps {
  actions?: ReactNode;
  collapsed?: boolean;
  title: ReactNode;
}

/** Exact title row used by the focused-chat Workstation environment trail. */
export const WorkstationTrailHeader: FC<WorkstationTrailHeaderProps> = ({
  actions,
  collapsed = false,
  title,
}) => (
  <div
    className={`mb-1 flex h-7 shrink-0 items-center ${
      collapsed ? "justify-center" : "justify-between pl-1"
    }`}
  >
    {!collapsed ? (
      <span className="min-w-0 truncate px-1 text-[11px] font-medium uppercase tracking-wide text-text-3">
        {title}
      </span>
    ) : null}
    {actions}
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

export default WorkstationTrailSurface;
