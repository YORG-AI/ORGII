/**
 * Dock Component
 *
 * Pure macOS-style dock bar — Glass pill with app icons.
 * Used by both My Station and Agent Station with different app lists.
 */
import type { LucideIcon } from "lucide-react";
import React, { memo } from "react";

import { GENERAL_LAYOUT_TOUR_TARGETS } from "@src/scaffold/Tutorials/generalLayoutTourConfig";

import {
  CompactDockIconColumn,
  DOCK_LUCIDE_ICON_PROPS,
  DockSegmentDivider,
  StationDockGlassPill,
  StationDockRow,
  dockIconHitAreaClassName,
} from "./dockLayout";

// ============================================
// Types
// ============================================

export interface DockAppItem {
  id: string;
  name: string;
  icon: LucideIcon;
}

interface DockProps {
  /**
   * Segments left-to-right; a vertical separator is drawn between consecutive segments.
   * Example: `[[chat], [code, browser, database]]` → Chat | others
   */
  segments: DockAppItem[][];
  activeApp: string | null;
  onAppClick?: (appId: string) => void;
}

function getTourTarget(appId: string): string | undefined {
  switch (appId) {
    case "all":
      return GENERAL_LAYOUT_TOUR_TARGETS.dockAllTabs;
    case "code":
    case "CODE_EDITOR":
      return GENERAL_LAYOUT_TOUR_TARGETS.dockCodeEditor;
    case "browser":
    case "BROWSER":
      return GENERAL_LAYOUT_TOUR_TARGETS.dockBrowser;
    case "project":
    case "STORY_MANAGER":
      return GENERAL_LAYOUT_TOUR_TARGETS.dockProjects;
    default:
      return undefined;
  }
}

// ============================================
// Component
// ============================================

export const Dock: React.FC<DockProps> = memo(
  ({ segments, activeApp, onAppClick }) => (
    <StationDockRow layout="centered">
      <StationDockGlassPill>
        {segments.map((segment, segmentIndex) => (
          <React.Fragment key={segmentIndex}>
            {segmentIndex > 0 && <DockSegmentDivider />}
            {segment.map((app) => {
              const isActive = activeApp === app.id;
              return (
                <CompactDockIconColumn key={app.id}>
                  <div
                    className={dockIconHitAreaClassName({ active: isActive })}
                    onClick={() => onAppClick?.(app.id)}
                    title={app.name}
                    data-tour-target={getTourTarget(app.id)}
                  >
                    {React.createElement(app.icon, DOCK_LUCIDE_ICON_PROPS)}
                  </div>
                </CompactDockIconColumn>
              );
            })}
          </React.Fragment>
        ))}
      </StationDockGlassPill>
    </StationDockRow>
  )
);

Dock.displayName = "Dock";
