// ============================================
// APICallPanel Component
// ============================================
/**
 * APICallPanel Component
 *
 * A debug panel for tracking and monitoring API calls made throughout the application.
 *
 * Features:
 * - API call tracking and monitoring
 * - Resizable panel
 * - Expandable operation details
 *
 * Keyboard Shortcut: ⌘5 (Cmd+5)
 */
import React from "react";
import { createPortal } from "react-dom";

import { HorizontalResizeHandle } from "@src/scaffold/Resize";

import PanelContent from "./components/PanelContent";
import PanelHeader from "./components/PanelHeader";
import { useAPICallPanel } from "./hooks/useAPICallPanel";
import { useAPICallPanelProvider } from "./hooks/useAPICallPanelProvider";
import type { APICallPanelProps } from "./types";

// ============================================
// Main Component
// ============================================

const APICallPanel: React.FC<APICallPanelProps> = ({
  visible,
  apiCalls,
  hotspots,
  timerHotspots,
  pushHotspots,
  onClose,
  onClear,
}) => {
  const {
    height,
    expandedCall,
    listRef,
    handleResizeStart,
    toggleExpand,
    setExpandedCall,
  } = useAPICallPanel();

  if (!visible) return null;

  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[999999] flex items-end justify-center">
      <div
        className="pointer-events-auto relative flex w-full max-w-full flex-col rounded-t-xl bg-bg-2 text-text-1 shadow-[0_-8px_32px_rgba(0,0,0,0.3),0_-2px_8px_rgba(0,0,0,0.2)] backdrop-blur-[20px] transition-[height] duration-100 ease-out"
        style={{ height: `${height}px` }}
      >
        {/* Resize handle */}
        <HorizontalResizeHandle onMouseDown={handleResizeStart} />

        {/* Header */}
        <PanelHeader
          apiCallsCount={apiCalls.length}
          onClear={onClear}
          onClose={onClose}
        />

        {/* Content */}
        <div className="min-h-0 flex-1 overflow-hidden" ref={listRef}>
          <PanelContent
            apiCalls={apiCalls}
            hotspots={hotspots}
            timerHotspots={timerHotspots}
            pushHotspots={pushHotspots}
            expandedCall={expandedCall}
            onToggleExpand={toggleExpand}
            onExpandedChange={setExpandedCall}
          />
        </div>
      </div>
    </div>,
    document.body
  );
};

// ============================================
// Provider Component
// ============================================

/**
 * APICallPanelProvider
 *
 * Provider component that handles keyboard shortcuts, state management,
 * and event listeners for the Panel API Call.
 */
export const APICallPanelProvider: React.FC = () => {
  const {
    visible,
    apiCalls,
    hotspots,
    timerHotspots,
    pushHotspots,
    handleClose,
    handleClear,
  } = useAPICallPanelProvider();

  return visible ? (
    <APICallPanel
      visible={visible}
      apiCalls={apiCalls}
      hotspots={hotspots}
      timerHotspots={timerHotspots}
      pushHotspots={pushHotspots}
      onClose={handleClose}
      onClear={handleClear}
    />
  ) : null;
};

export default APICallPanel;
