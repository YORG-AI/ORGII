/**
 * EventWrapper - Dual-mode event component wrapper
 *
 * Adapts components to work in both Interactive and Simulation modes:
 * - Interactive: Uses EventCollapseWrapper (collapsible, interactive)
 * - Simulation: Uses EventContainer primitive (always expanded, read-only)
 *
 * Performance optimizations:
 * - Memoized component with chunk_id-based comparison
 * - Separate rendering paths for different modes
 */
import React, { memo, useState } from "react";

import Collapse from "@src/components/Collapse";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import {
  ArrowExpand01Icon,
  ArrowRight01Icon,
  HugeiconsIcon,
  Wrench01Icon,
} from "@src/icons";
import type { BackendEvent } from "@src/types/session/steps";

const FONT_SANS = "var(--app-font-family)";

// ============================================
// EventCollapseWrapper (Internal Component)
// ============================================

interface EventCollapseWrapperProps {
  event: SessionEvent | BackendEvent;
  expand?: boolean;
  children: React.ReactNode;
  className?: string;
  customHeader?: React.ReactNode;
  showHeader?: boolean;
}

/**
 * Render a simple fallback header for interactive mode.
 * This is rarely used since most rendering is in simulation mode.
 */
function renderFallbackHeader(
  event: SessionEvent | BackendEvent
): React.ReactNode {
  const fnName =
    (event as SessionEvent).functionName ||
    (event as BackendEvent).function ||
    "Event";
  const label = fnName
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());

  return (
    <div className="flex w-full items-center gap-3 truncate">
      <HugeiconsIcon
        icon={Wrench01Icon}
        data-icon="wrench"
        size={16}
        className="text-text-2"
      />
      <span className="text-[14px] font-normal text-text-2">{label}</span>
    </div>
  );
}

/**
 * Event Collapse wrapper component
 * Unified management of header display logic
 */
const EventCollapseWrapper: React.FC<EventCollapseWrapperProps> = ({
  event,
  expand = true,
  children,
  className = "",
  customHeader,
  showHeader = true,
}) => {
  const [activeKey, setActiveKey] = useState(expand ? "1" : "");

  // Use customHeader if provided, otherwise use simple fallback header
  const header = showHeader
    ? customHeader !== undefined
      ? customHeader
      : renderFallbackHeader(event)
    : null;

  return (
    <div className={`event-collapse-wrapper ${className}`}>
      <Collapse
        className="rounded-xl border-border-2"
        activeKey={activeKey}
        onChange={(key) => {
          const newKey = Array.isArray(key) ? key[0] : key;
          setActiveKey(newKey === "1" ? "" : "1");
        }}
      >
        <Collapse.Item
          key="1"
          expandIcon={
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              data-icon="chevron-right"
              size={16}
              strokeWidth={1.75}
              className="text-text-2"
            />
          }
          header={header}
          extra={
            <HugeiconsIcon
              icon={ArrowExpand01Icon}
              data-icon="maximize-2"
              size={16}
              strokeWidth={1.75}
              className="text-text-2"
            />
          }
        >
          {children}
        </Collapse.Item>
      </Collapse>
    </div>
  );
};

// ============================================
// EventWrapper Component
// ============================================

// Component rendering modes
export type EventRenderMode = "interactive" | "simulation";

// Wrapper props interface
export interface EventWrapperProps {
  event: BackendEvent;
  mode?: EventRenderMode;
  expand?: boolean;
  children: React.ReactNode;
  className?: string;
  customHeader?: React.ReactNode;
  showHeader?: boolean;
  padding?: string; // Padding class for simulation mode (e.g., "p-4")
}

/**
 * Wrapper that adapts components for both rendering modes
 */
const EventWrapperComponent: React.FC<EventWrapperProps> = ({
  event,
  mode = "interactive",
  expand = true,
  children,
  className = "",
  customHeader,
  showHeader = true,
  padding = "",
}) => {
  // Simulation mode: flat container (no collapse) - Gemini style
  if (mode === "simulation") {
    const containerClass =
      `flex h-full min-h-0 flex-col gap-5 overflow-y-auto ${padding}`.trim();
    return (
      <div className={containerClass} style={{ fontFamily: FONT_SANS }}>
        {children}
      </div>
    );
  }

  // Interactive mode: Use EventCollapseWrapper (collapsible)
  return (
    <EventCollapseWrapper
      event={event}
      expand={expand}
      className={className}
      customHeader={customHeader}
      showHeader={showHeader}
    >
      {children}
    </EventCollapseWrapper>
  );
};

/**
 * Helper to extract event ID from various formats (chunk_id is the canonical identifier)
 */
const getEventId = (event: Record<string, unknown>): string =>
  (event?.chunk_id as string) || (event?.msg_id as string) || "";

/**
 * Custom comparison for EventWrapper.
 * Prevents re-renders when chunk_id and mode haven't changed.
 */
const arePropsEqual = (
  prev: EventWrapperProps,
  next: EventWrapperProps
): boolean => {
  // Re-render if chunk_id changed (check both formats)
  if (
    getEventId(prev.event as unknown as Record<string, unknown>) !==
    getEventId(next.event as unknown as Record<string, unknown>)
  )
    return false;
  // Re-render if mode changed
  if (prev.mode !== next.mode) return false;
  // Re-render if expand state changed (interactive mode)
  if (prev.expand !== next.expand) return false;
  // Re-render if visual props changed
  if (prev.padding !== next.padding) return false;
  if (prev.showHeader !== next.showHeader) return false;
  // Children are compared by reference - this is fine since
  // memoized child components will have stable references
  if (prev.children !== next.children) return false;

  return true;
};

export const EventWrapper = memo(EventWrapperComponent, arePropsEqual);
EventWrapper.displayName = "EventWrapper";

export default EventWrapper;
