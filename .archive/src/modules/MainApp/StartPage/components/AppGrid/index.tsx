/**
 * AppGrid Component
 *
 * Launchpad with staggered honeycomb layout.
 * Uses tokenized translucent styling with one accent for Start Session.
 *
 * Features:
 * - Staggered honeycomb grid (4-5-4 pattern)
 * - Translucent circular backgrounds
 * - Lucide icons with contrast colors
 * - Hover animations with scale effect
 *
 * Tab Behavior: Uses "new" mode - clicking app items creates new tabs.
 * Cmd+click always opens in new tab.
 *
 * Drag/pointer logic lives in useAppGridDrag.ts.
 * Single icon rendering lives in AppGridIcon.tsx.
 */
import { motion } from "framer-motion";
import { useAtom, useAtomValue } from "jotai";
import React, { useCallback, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";

import { ACTION_ID, useActionSystemOptional } from "@src/ActionSystem";
import {
  HOST_DESKTOP,
  resolveHostDesktop,
} from "@src/config/windowChromeRadius";
import { CODEMIRROR_STYLE_NONCE } from "@src/features/CodeMirror/config/nonce";
import { useRegionLuminance } from "@src/hooks/theme/useRegionLuminance";
import { appGridConfigAtom } from "@src/store/ui/appGridAtom";
import { resolvedBackgroundConfigAtom } from "@src/store/ui/backgroundConfigAtom";
import { openExternalLink } from "@src/util/platform/ipcRenderer";
import { classNames } from "@src/util/ui/classNames";

import AppGridEditPanel from "../AppGridEditPanel";
import { AppGridIcon } from "./AppGridIcon";
import { APP_GRID_ITEMS, type AppItem } from "./config";
import { useAppGridDrag } from "./useAppGridDrag";

const IS_MACOS_HOST = resolveHostDesktop() === HOST_DESKTOP.MACOS;

// ============================================
// Styles
// ============================================

const GRID_STYLES = `
  .vision-app-item {
    transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
    user-select: none;
    -webkit-user-select: none;
  }
  
  .vision-app-item:active:not(.shaking) {
    transform: scale(0.95);
  }
  
  .vision-app-icon {
    transition: box-shadow 0.2s ease, transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1), background 0.2s ease, filter 0.2s ease;
    pointer-events: none;
  }

  /* Liquid-glass specular sheen: simulates light catching the top of a
     curved glass surface. Sits below the icon (which is z-index: 1). */
  .vision-app-icon::before {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: var(--start-app-icon-sheen, none);
    pointer-events: none;
  }

  /* Refraction rim: masked to the outer band of the circle, it re-filters
     the backdrop (extra blur + brightness + saturation) and carries a conic
     edge-light, so the edge reads as light bending through a lens. WebKit
     has no SVG displacement in backdrop-filter, so this band is the
     distortion stand-in. */
  .vision-app-icon::after {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: var(--start-app-icon-rim-light, none);
    backdrop-filter: var(--start-app-icon-rim-filter, none);
    -webkit-backdrop-filter: var(--start-app-icon-rim-filter, none);
    -webkit-mask-image: radial-gradient(
      circle closest-side,
      transparent 70%,
      black 88%
    );
    mask-image: radial-gradient(
      circle closest-side,
      transparent 70%,
      black 88%
    );
    pointer-events: none;
  }

  .vision-app-item:not(.shaking):hover .vision-app-icon {
    transform: scale(1.08);
    filter: brightness(1.06);
  }

  /* iOS-style shake animation */
  @keyframes shake {
    0%, 100% { transform: rotate(-1deg) scale(1); }
    25% { transform: rotate(1deg) scale(1); }
    50% { transform: rotate(-1deg) scale(1); }
    75% { transform: rotate(1deg) scale(1); }
  }

  .vision-app-item.shaking {
    animation: shake 0.4s ease-in-out infinite;
    cursor: grab;
  }

  .vision-app-item.shaking .vision-app-icon {
    transform: scale(1);
  }

  .vision-app-item.dragging {
    opacity: 0.5;
    cursor: grabbing;
    animation: none;
  }

  .vision-app-item.drag-over {
    transform: scale(1.15);
    animation: none;
  }
`;

// ============================================
// Honeycomb Configuration
// ============================================

const HONEYCOMB_CONFIG = {
  iconSize: 64,
  horizontalGap: 56,
  verticalGap: 36,
  rowPattern: [4, 5, 4] as const,
};

const APP_GRID_ACTION_IDS: Partial<Record<string, string>> = {
  "create-session": ACTION_ID.AGENT_STATION_CREATE_SESSION,
  editor: ACTION_ID.APP_GO_TO_EDITOR,
  browser: ACTION_ID.APP_GO_TO_BROWSER,
  kanban: ACTION_ID.APP_GO_TO_KANBAN,
  integrations: ACTION_ID.APP_GO_TO_INTEGRATIONS,
  economy: ACTION_ID.APP_GO_TO_MARKET,
  "agent-orgs": ACTION_ID.APP_GO_TO_AGENT_ORGS,
  // Legacy launchpad action: intentionally absent so it falls through to
  // APP_NAVIGATE and opens the renamed Dashboard in the Code Editor route.
  changelog: ACTION_ID.APP_GO_TO_CHANGELOG,
  projects: ACTION_ID.APP_GO_TO_STORIES,
  settings: ACTION_ID.APP_GO_TO_SETTINGS,
};

// ============================================
// Types
// ============================================

interface AppGridProps {
  className?: string;
}

// ============================================
// Component
// ============================================

const AppGrid: React.FC<AppGridProps> = ({ className }) => {
  const navigate = useNavigate();
  const actionSystem = useActionSystemOptional();

  const { getRegion } = useRegionLuminance();
  const contentLuminance = getRegion("content");

  const {
    draggedId,
    dragOverId,
    editMode,
    setEditMode,
    isDraggingRef,
    gridContainerRef,
    handleTouchStart,
    handleTouchEnd,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    handlePointerCancel,
  } = useAppGridDrag();

  const [gridConfig, setGridConfig] = useAtom(appGridConfigAtom);
  const backgroundConfig = useAtomValue(resolvedBackgroundConfigAtom);
  const shouldUseAdaptiveColors = Boolean(
    !IS_MACOS_HOST &&
    backgroundConfig.adaptiveColors &&
    backgroundConfig.selectedImageId
  );

  const sortedApps = useMemo(() => {
    const appMap = new Map(APP_GRID_ITEMS.map((app) => [app.id, app]));
    const defaultIndexById = new Map(
      APP_GRID_ITEMS.map((app, index) => [app.id, index])
    );
    const orderedApps = gridConfig.appOrder
      .map((id) => appMap.get(id))
      .filter((app): app is AppItem => app !== undefined);
    const orderedIds = new Set(orderedApps.map((app) => app.id));

    for (const missingApp of APP_GRID_ITEMS.filter(
      (app) => !orderedIds.has(app.id)
    )) {
      const defaultIndex = defaultIndexById.get(missingApp.id) ?? Infinity;
      const insertIndex = orderedApps.findIndex(
        (app) => (defaultIndexById.get(app.id) ?? Infinity) > defaultIndex
      );
      if (insertIndex === -1) orderedApps.push(missingApp);
      else orderedApps.splice(insertIndex, 0, missingApp);
    }

    return orderedApps;
  }, [gridConfig.appOrder]);

  const honeycombRows = useMemo(() => {
    const rows: AppItem[][] = [];
    let currentIndex = 0;
    let patternIndex = 0;
    while (currentIndex < sortedApps.length) {
      const rowSize =
        HONEYCOMB_CONFIG.rowPattern[
          patternIndex % HONEYCOMB_CONFIG.rowPattern.length
        ];
      const row = sortedApps.slice(currentIndex, currentIndex + rowSize);
      if (row.length > 0) rows.push(row);
      currentIndex += rowSize;
      patternIndex++;
    }
    return rows;
  }, [sortedApps]);

  const handleAppClick = useCallback(
    (app: AppItem, _event?: React.MouseEvent) => {
      // External-link tiles (e.g. the open-source repo) open in the system
      // browser instead of navigating an in-app route.
      if (app.externalUrl) {
        void openExternalLink(app.externalUrl);
        return;
      }

      const path = app.routePath;
      const actionId = APP_GRID_ACTION_IDS[app.action];
      if (actionId && actionSystem?.isValidAction(actionId)) {
        void actionSystem.dispatch(actionId, {}, "user");
        return;
      }

      if (actionSystem?.isValidAction(ACTION_ID.APP_NAVIGATE)) {
        void actionSystem.dispatch(
          ACTION_ID.APP_NAVIGATE,
          { path, title: app.labelKey },
          "user"
        );
        return;
      }

      navigate(path);
    },
    [actionSystem, navigate]
  );

  useEffect(() => {
    if (!editMode) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest('[data-toolbar-section="right-actions"]')) return;
      if (target.closest(".toolbar-dropdown-item")) return;
      if (
        gridContainerRef.current &&
        !gridContainerRef.current.contains(target)
      ) {
        setEditMode(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [editMode, setEditMode, gridContainerRef]);

  const itemWidth = gridConfig.horizontalGap + HONEYCOMB_CONFIG.iconSize;
  const maxRowCount = Math.max(...HONEYCOMB_CONFIG.rowPattern);
  const gridWidth = maxRowCount * itemWidth;
  const iconColor = shouldUseAdaptiveColors
    ? contentLuminance.isLight
      ? "rgba(0, 0, 0, 0.8)"
      : "rgba(255, 255, 255, 0.9)"
    : "var(--color-text-1)";
  const labelColor = shouldUseAdaptiveColors
    ? contentLuminance.textColor
    : "var(--color-text-1)";

  let globalIndex = 0;

  return (
    <>
      <style nonce={CODEMIRROR_STYLE_NONCE}>{GRID_STYLES}</style>

      <motion.div
        ref={gridContainerRef}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5 }}
        className={classNames("relative flex flex-col", className)}
        style={{ width: gridWidth }}
      >
        {honeycombRows.map((row, rowIndex) => (
          <div
            key={rowIndex}
            className="flex"
            style={{
              marginTop: rowIndex === 0 ? 0 : `${gridConfig.verticalGap}px`,
              marginLeft: rowIndex % 2 === 0 ? `${itemWidth / 2}px` : 0,
            }}
          >
            {row.map((app) => {
              const element = (
                <AppGridIcon
                  key={app.id}
                  app={app}
                  globalIndex={globalIndex}
                  itemWidth={itemWidth}
                  iconSize={HONEYCOMB_CONFIG.iconSize}
                  iconColor={iconColor}
                  labelColor={labelColor}
                  editMode={editMode}
                  isBeingDragged={draggedId === app.id}
                  isDragOver={dragOverId === app.id}
                  isDraggingRef={isDraggingRef}
                  onAppClick={handleAppClick}
                  onPointerDown={(e) => handlePointerDown(e, app.id)}
                  onPointerMove={(e) => handlePointerMove(e, app.id)}
                  onPointerUp={handlePointerUp}
                  onPointerCancel={handlePointerCancel}
                  onTouchStart={handleTouchStart}
                  onTouchEnd={handleTouchEnd}
                />
              );
              globalIndex++;
              return element;
            })}
          </div>
        ))}

        {editMode && (
          <div
            className="fixed"
            style={{
              bottom: "60px",
              right: "8px",
              width: "240px",
              zIndex: 100,
            }}
          >
            <AppGridEditPanel
              horizontalGap={gridConfig.horizontalGap}
              verticalGap={gridConfig.verticalGap}
              onHorizontalGapChange={(value) =>
                setGridConfig({ ...gridConfig, horizontalGap: value })
              }
              onVerticalGapChange={(value) =>
                setGridConfig({ ...gridConfig, verticalGap: value })
              }
            />
          </div>
        )}
      </motion.div>
    </>
  );
};

export default AppGrid;
