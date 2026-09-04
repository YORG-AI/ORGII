/**
 * SimulatorFrame Component
 *
 * Base frame component for simulator views - similar to EventBlock for chat panel.
 * Provides consistent visual structure:
 * - Rounded border with shadow (simulator "computer" look)
 * - Traffic lights header
 * - Content area
 *
 * Used for:
 * - Static content (Kanban, Changes) - direct use
 * - Dynamic content (Follow) - building block for SimulatorContentArea
 */
import React, { memo } from "react";

import type { IconSvgElement } from "@src/icons";
import type { StationMode } from "@src/store/ui/simulatorAtom";

import SimulatorTitleBar from "../SimulatorTitleBar";
import {
  type FrameRadius,
  getSimulatorFrameContainerClasses,
  getSimulatorFrameContentClasses,
} from "./config";

// ============================================
// Types
// ============================================

interface SimulatorFrameProps {
  /** Title to display in the header */
  title: string;
  /** Icon glyph before title (e.g. same as dock for the active tool). */
  titleCenterIcon?: IconSvgElement;
  /** Border radius option: 12 (default simulator) or 20 (WorkStation) */
  radius?: FrameRadius;
  /** Custom header background color (e.g., IDE title bar theme) */
  headerBackgroundColor?: string;
  /** Custom header text color (e.g., IDE title bar theme) */
  headerTextColor?: string;
  /** Force show header bottom border */
  showHeaderBorder?: boolean;
  /** Whether to show the title bar header (default: true) */
  showHeader?: boolean;
  /** Custom className for container */
  containerClassName?: string;
  /** Custom className for content area */
  contentClassName?: string;
  /** Content to render inside the frame */
  children: React.ReactNode;
  /** Custom actions for the title bar right side (e.g., settings button) */
  customActions?: React.ReactNode;
  /** Current station mode (My Station / Agent Station) */
  stationMode?: StationMode;
  /** Callback when station mode changes */
  onStationModeChange?: (mode: StationMode) => void;
  /** Which station modes to show in the pill. Defaults to both. */
  stationModeOptions?: StationMode[];
}

// ============================================
// Component
// ============================================

export const SimulatorFrame: React.FC<SimulatorFrameProps> = memo(
  ({
    title,
    titleCenterIcon,
    radius = 12,
    showHeader = true,
    headerBackgroundColor,
    headerTextColor,
    showHeaderBorder,
    containerClassName = "",
    contentClassName = "",
    children,
    customActions,
    stationMode,
    onStationModeChange,
    stationModeOptions,
  }) => {
    return (
      <div
        className={`${getSimulatorFrameContainerClasses(radius)} ${containerClassName}`}
      >
        {/* Header with traffic lights - uses dock configuration for app name */}
        {showHeader && (
          <SimulatorTitleBar
            title={title}
            titleCenterIcon={titleCenterIcon}
            backgroundColor={headerBackgroundColor}
            textColor={headerTextColor}
            showBorder={showHeaderBorder}
            customActions={customActions}
            stationMode={stationMode}
            onStationModeChange={onStationModeChange}
            stationModeOptions={stationModeOptions}
          />
        )}

        {/* Content area */}
        <div
          className={`${getSimulatorFrameContentClasses()} ${contentClassName}`}
        >
          {children}
        </div>
      </div>
    );
  }
);

SimulatorFrame.displayName = "SimulatorFrame";

export default SimulatorFrame;
