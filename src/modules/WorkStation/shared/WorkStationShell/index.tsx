/**
 * WorkStationShell Component
 *
 * Shared layout shell for Workstation apps providing consistent structure:
 * - CodeEditor (code editor) - EditorPrimarySidebar
 * - DatabaseManager (database browser) - DatabasePrimarySidebar
 * - Browser (web browser) - BrowserPrimarySidebar
 * - ProjectManager, Chat, SessionReplay variants
 *
 * Layout modes:
 * - Flex mode (no `secondaryPanelConfig`): primary sidebar + content,
 *   used by apps that don't need a right-rail / bottom panel.
 * - Grid mode (with `secondaryPanelConfig`): primary sidebar + content +
 *   a single shared secondary panel that can flip between right rail
 *   and bottom row via CSS `grid-template-areas`. The secondary panel's
 *   React subtree is mounted once; only the grid placement changes on
 *   toggle, so terminal/devtools state survives position flips.
 */
import i18next from "i18next";
import React, { memo } from "react";

import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import { useResizeContextMenu } from "@src/hooks/ui/useResizeContextMenu";
import { useResizeHandle } from "@src/hooks/ui/useResizeHandle";
import {
  HorizontalResizeHandle,
  VerticalResizeHandle,
} from "@src/scaffold/Resize";
import { classNames } from "@src/util/ui/classNames";

import {
  DEFAULT_PRIMARY_SIDEBAR_CONFIG,
  type PrimarySidebarConfig,
  type SecondaryPanelConfig,
} from "./config";
import "./index.scss";

// ============================================
// Types
// ============================================

export interface WorkStationShellProps {
  /** Primary sidebar configuration. */
  primarySidebarConfig?: PrimarySidebarConfig;
  /**
   * Shared secondary panel that can live on the right rail OR at the
   * bottom. When supplied, the panel content is mounted once; CSS grid
   * moves it between the right rail and the bottom row without
   * remounting.
   */
  secondaryPanelConfig?: SecondaryPanelConfig;

  /** Main content area */
  content: React.ReactNode;
  /** Status bar component */
  statusBar: React.ReactNode;
  /** Layout mode — determines whether the primary sidebar is on the left or right. */
  layoutMode?: "left" | "right";
  /** Additional class name for the container */
  className?: string;
  /** Class name for the app (used for BEM styling) */
  appClassName?: string;
}

// ============================================
// Main Component
// ============================================

const noop = () => {};

interface PrimarySidebarPanelProps {
  className: string;
  width: number;
  onContextMenu?: React.MouseEventHandler<HTMLDivElement>;
  content: React.ReactNode;
}

const PrimarySidebarPanel = memo(
  ({ className, width, onContextMenu, content }: PrimarySidebarPanelProps) => (
    <div className={className} style={{ width }} onContextMenu={onContextMenu}>
      {content}
    </div>
  )
);
PrimarySidebarPanel.displayName = "PrimarySidebarPanel";

interface ContentPanelProps {
  className: string;
  content: React.ReactNode;
}

const ContentPanel = memo(({ className, content }: ContentPanelProps) => (
  <div className={className}>
    <div className="work-station-shell__main-content">{content}</div>
  </div>
));
ContentPanel.displayName = "ContentPanel";

interface SecondaryPanelProps {
  className: string;
  position: "right" | "bottom";
  size: number;
  onContextMenu?: React.MouseEventHandler<HTMLDivElement>;
  content: React.ReactNode;
}

const SecondaryPanel = memo(
  ({
    className,
    position,
    size,
    onContextMenu,
    content,
  }: SecondaryPanelProps) => (
    <div
      className={className}
      style={position === "right" ? { width: size } : { height: size }}
      onContextMenu={onContextMenu}
    >
      {content}
    </div>
  )
);
SecondaryPanel.displayName = "SecondaryPanel";

export const WorkStationShell: React.FC<WorkStationShellProps> = memo(
  ({
    primarySidebarConfig,
    secondaryPanelConfig,
    content,
    statusBar,
    layoutMode = "left",
    className,
    appClassName,
  }) => {
    const resolvedPrimarySidebar = {
      content: primarySidebarConfig?.content,
      collapsed:
        primarySidebarConfig?.collapsed ??
        DEFAULT_PRIMARY_SIDEBAR_CONFIG.collapsed,
      size: primarySidebarConfig?.size ?? DEFAULT_PRIMARY_SIDEBAR_CONFIG.size,
      onSizeChange: primarySidebarConfig?.onSizeChange,
      minSize:
        primarySidebarConfig?.minSize ?? DEFAULT_PRIMARY_SIDEBAR_CONFIG.minSize,
      maxSize:
        primarySidebarConfig?.maxSize ?? DEFAULT_PRIMARY_SIDEBAR_CONFIG.maxSize,
      resetSize:
        primarySidebarConfig?.resetSize ??
        DEFAULT_PRIMARY_SIDEBAR_CONFIG.resetSize,
      onClose: primarySidebarConfig?.onClose,
      onPositionChange: primarySidebarConfig?.onPositionChange,
    };

    const isLeftMode = layoutMode === "left";
    const primarySidebarTargetPosition = isLeftMode ? "right" : "left";

    // ------------------------------------------------------------------
    // Primary sidebar resize
    // ------------------------------------------------------------------
    const {
      handleMouseDown: handlePrimarySidebarResize,
      isResizing: isPrimarySidebarResizing,
    } = useResizeHandle(
      resolvedPrimarySidebar.size,
      resolvedPrimarySidebar.onSizeChange ?? noop,
      {
        direction: "horizontal",
        minSize: resolvedPrimarySidebar.minSize,
        maxSize: resolvedPrimarySidebar.maxSize,
        isReversed: !isLeftMode,
      }
    );

    const handlePrimarySidebarContextMenu = useResizeContextMenu({
      dimension: "width",
      currentSize: resolvedPrimarySidebar.size,
      defaultSize: resolvedPrimarySidebar.resetSize,
      minSize: resolvedPrimarySidebar.minSize,
      onSizeChange: resolvedPrimarySidebar.onSizeChange ?? noop,
      positionAction: resolvedPrimarySidebar.onPositionChange
        ? {
            target: primarySidebarTargetPosition,
            onSelect: () => {
              resolvedPrimarySidebar.onPositionChange?.(
                primarySidebarTargetPosition
              );
            },
          }
        : undefined,
      onClose: resolvedPrimarySidebar.onClose,
    });

    // ------------------------------------------------------------------
    // Secondary panel resize
    //
    // Drag-direction semantics:
    // - right position: handle at LEFT edge; drag left → grow →
    //   isReversed=true on a horizontal axis (no extra vertical flip).
    // - bottom position: handle at TOP edge; drag up → grow. Vertical
    //   axis already flips sign once inside `useResizeHandle` (drag up
    //   = clientY decreases = negative delta → flipped to positive),
    //   so isReversed=false.
    // ------------------------------------------------------------------
    const secondaryPosition = secondaryPanelConfig?.position ?? "right";
    const secondarySize = secondaryPanelConfig?.size ?? 0;
    const secondaryOnSizeChange = secondaryPanelConfig?.onSizeChange ?? noop;
    const secondaryMinSize = secondaryPanelConfig?.minSize ?? 100;
    const secondaryMaxSize = secondaryPanelConfig?.maxSize ?? 1200;
    const { handleMouseDown: handleSecondaryResize } = useResizeHandle(
      secondarySize,
      secondaryOnSizeChange,
      {
        direction: secondaryPosition === "right" ? "horizontal" : "vertical",
        minSize: secondaryMinSize,
        maxSize: secondaryMaxSize,
        isReversed: secondaryPosition === "right",
      }
    );
    const handleSecondaryContextMenu = useResizeContextMenu({
      dimension: secondaryPosition === "right" ? "width" : "height",
      currentSize: secondarySize,
      defaultSize: secondaryPanelConfig?.resetSize ?? secondarySize,
      minSize: secondaryMinSize,
      onSizeChange: secondaryOnSizeChange,
      onClose: secondaryPanelConfig?.onClose,
    });

    // ------------------------------------------------------------------
    // Elements
    // ------------------------------------------------------------------
    // Primary sidebar: always rendered; collapsed hides via CSS (preserves
    // component state). Right-click anywhere on the sidebar surface opens
    // the resize context menu.
    const primarySidebarElement = (
      <PrimarySidebarPanel
        className={classNames(
          "work-station-shell__side-panel",
          !isLeftMode && "work-station-shell__side-panel--right",
          resolvedPrimarySidebar.collapsed &&
            "work-station-shell__side-panel--collapsed",
          appClassName && `${appClassName}__side-panel`
        )}
        width={
          resolvedPrimarySidebar.collapsed ? 0 : resolvedPrimarySidebar.size
        }
        onContextMenu={
          !resolvedPrimarySidebar.collapsed &&
          resolvedPrimarySidebar.onSizeChange
            ? handlePrimarySidebarContextMenu
            : undefined
        }
        content={resolvedPrimarySidebar.content}
      />
    );

    const primarySidebarResizeHandle = !resolvedPrimarySidebar.collapsed &&
      resolvedPrimarySidebar.onSizeChange && (
        <VerticalResizeHandle
          indicatorPlacement="center"
          isResizing={isPrimarySidebarResizing}
          variant="border"
          onMouseDown={handlePrimarySidebarResize}
          onContextMenu={handlePrimarySidebarContextMenu}
          tooltipLabel={i18next.t("common:commands.hidePrimarySidebar")}
          tooltipShortcut={getShortcutKeys("toggle_workstation_sidebar")}
        />
      );

    const contentPanelElement = (
      <ContentPanel
        className={classNames(
          "work-station-shell__content-panel",
          appClassName && `${appClassName}__content-panel`
        )}
        content={content}
      />
    );

    // Secondary panel: single mount. Always rendered when the config is
    // present; collapse/maximize are reflected via CSS classes on the
    // grid container so React never has to remount the subtree.
    const secondaryPanelCollapsed =
      !secondaryPanelConfig ||
      secondaryPanelConfig.collapsed ||
      !secondaryPanelConfig.content;
    const showSecondaryResizeHandle =
      secondaryPanelConfig &&
      !secondaryPanelCollapsed &&
      secondaryPanelConfig.onSizeChange;

    const secondaryPanelElement = secondaryPanelConfig && (
      <SecondaryPanel
        className={classNames(
          "work-station-shell__secondary-panel",
          `work-station-shell__secondary-panel--${secondaryPosition}`,
          secondaryPosition === "right" &&
            (isLeftMode
              ? "work-station-shell__secondary-panel--right"
              : "work-station-shell__secondary-panel--left"),
          secondaryPanelCollapsed &&
            "work-station-shell__secondary-panel--collapsed",
          appClassName && `${appClassName}__secondary-panel`
        )}
        position={secondaryPosition}
        size={secondarySize}
        onContextMenu={
          !secondaryPanelCollapsed && secondaryPanelConfig.onSizeChange
            ? handleSecondaryContextMenu
            : undefined
        }
        content={secondaryPanelConfig.content}
      />
    );

    // Resize handle for secondary panel — its own grid cell between
    // content and the secondary panel. Overflow on the handle cell must
    // be visible so the 6px hit-area extension isn't clipped.
    const secondaryResizeHandleElement = showSecondaryResizeHandle ? (
      secondaryPosition === "right" ? (
        <VerticalResizeHandle
          variant="border"
          onMouseDown={handleSecondaryResize}
          onContextMenu={handleSecondaryContextMenu}
        />
      ) : (
        <HorizontalResizeHandle
          variant="border"
          onMouseDown={handleSecondaryResize}
          onContextMenu={handleSecondaryContextMenu}
        />
      )
    ) : null;

    const hasSecondary = !!secondaryPanelConfig;

    return (
      <div
        className={classNames("work-station-shell", appClassName, className)}
      >
        {hasSecondary ? (
          <div
            className={classNames(
              "work-station-shell__grid",
              `work-station-shell__grid--secondary-${secondaryPosition}`,
              !isLeftMode && "work-station-shell__grid--reversed",
              resolvedPrimarySidebar.collapsed &&
                "work-station-shell__grid--primary-collapsed",
              secondaryPanelCollapsed &&
                "work-station-shell__grid--secondary-collapsed"
            )}
          >
            <div className="work-station-shell__grid-sidebar">
              {primarySidebarElement}
            </div>
            <div className="work-station-shell__grid-sidebar-handle">
              {primarySidebarResizeHandle}
            </div>
            <div className="work-station-shell__grid-content">
              {contentPanelElement}
            </div>
            <div className="work-station-shell__grid-secondary-handle">
              {secondaryResizeHandleElement}
            </div>
            <div className="work-station-shell__grid-secondary">
              {secondaryPanelElement}
            </div>
          </div>
        ) : (
          <div
            className={classNames(
              "work-station-shell__container",
              !isLeftMode && "work-station-shell__container--reversed"
            )}
          >
            {primarySidebarElement}
            {primarySidebarResizeHandle}
            {contentPanelElement}
          </div>
        )}

        {statusBar}
      </div>
    );
  }
);

WorkStationShell.displayName = "WorkStationShell";
