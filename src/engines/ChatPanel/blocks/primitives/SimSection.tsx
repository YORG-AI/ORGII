/**
 * SimSection - Labeled card-style section for simulator/trajectory rendering.
 *
 * Used by simulator-variant event renderers (error, web-search, mcp, tool-call).
 * Different from BlockSection (chat-style INPUT/OUTPUT labels) — this one
 * supports card/terminal/thinking variants with full border + background.
 */
import { ReactNode, memo, useMemo } from "react";

import { SESSION_UI_TOKENS } from "./config";

const FONT_SANS = "var(--app-font-family)";

export interface SimSectionProps {
  label: string;
  children: ReactNode;
  grow?: boolean;
  icon?: string;
  variant?: "default" | "card" | "terminal" | "thinking";
}

export const SimSection = memo<SimSectionProps>(
  ({ label, children, grow = false, icon, variant = "default" }) => {
    const containerClass = useMemo(() => {
      const base = `flex flex-col ${grow ? "min-h-0 flex-1" : ""}`;

      switch (variant) {
        case "card":
          return `${base} rounded-xl border border-border-1 bg-event-block overflow-hidden`;
        case "terminal":
          return `${base} rounded-xl border border-border-1 overflow-hidden`;
        case "thinking":
          return `${base} rounded-xl border border-success-6/20 bg-success-6/5 overflow-hidden`;
        default:
          return base;
      }
    }, [grow, variant]);

    const headerClass = useMemo(() => {
      switch (variant) {
        case "card":
        case "terminal":
          return "flex items-center gap-2.5 px-4 py-2.5 border-b border-border-1 bg-event-block/80";
        case "thinking":
          return "flex items-center gap-2.5 px-4 py-2.5 border-b border-success-6/20 bg-success-6/5";
        default:
          return "flex items-center gap-2 mb-3";
      }
    }, [variant]);

    const labelClass = useMemo(() => {
      switch (variant) {
        case "thinking":
          return SESSION_UI_TOKENS.TEXT.LABEL_SUCCESS;
        default:
          return SESSION_UI_TOKENS.TEXT.LABEL_XS;
      }
    }, [variant]);

    const contentClass = useMemo(() => {
      switch (variant) {
        case "card":
        case "terminal":
        case "thinking":
          return "group/section-content relative p-4";
        default:
          return "group/section-content relative";
      }
    }, [variant]);

    const iconColor = useMemo(() => {
      switch (variant) {
        case "thinking":
          return "text-success-6";
        default:
          return "text-text-3";
      }
    }, [variant]);

    return (
      <div className={containerClass}>
        <div className={headerClass}>
          {variant === "thinking" && (
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success-6 opacity-75"></span>
              <span className="relative inline-flex h-2 w-2 rounded-full bg-success-6"></span>
            </span>
          )}
          {icon && <i className={`${icon} text-[13px] ${iconColor}`} />}
          <span
            className={`select-text ${labelClass}`}
            style={{ fontFamily: FONT_SANS }}
          >
            {label}
          </span>
          {variant === "default" && <div className="h-px flex-1 bg-border-2" />}
        </div>
        <div className={contentClass}>{children}</div>
      </div>
    );
  },
  (prev, next) => {
    if (prev.label !== next.label) return false;
    if (prev.grow !== next.grow) return false;
    if (prev.icon !== next.icon) return false;
    if (prev.variant !== next.variant) return false;
    if (prev.children !== next.children) return false;
    return true;
  }
);
SimSection.displayName = "SimSection";

export default SimSection;
