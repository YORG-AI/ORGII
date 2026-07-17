/**
 * SidebarBase
 *
 * The foundational wrapper for all sidebar components.
 * Handles: transparent sidebar surface, resize, collapse, traffic lights spacing.
 *
 * @example
 * ```tsx
 * <SidebarBase sidebarId="terminal">
 *   <SidebarHeader title="Terminal" />
 *   <SidebarList>
 *     <SidebarItem ... />
 *   </SidebarList>
 * </SidebarBase>
 * ```
 */
import {
  MenuItem,
  PredefinedMenuItem,
  Menu as TauriMenu,
} from "@tauri-apps/api/menu";
import i18next from "i18next";
import { useAtomValue, useSetAtom } from "jotai";
import { PanelLeft, Plus, X } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef } from "react";

import { KeyboardShortcutTooltipContent } from "@src/components/KeyboardShortcut";
import Tooltip from "@src/components/Tooltip";
import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import {
  HOST_DESKTOP,
  resolveHostDesktop,
} from "@src/config/windowChromeRadius";
import { createLogger } from "@src/hooks/logger";
import { useSettingValue } from "@src/hooks/settings/useSettings";
import { useSidebarState } from "@src/hooks/ui/sidebar/useSidebarState";
import {
  PANE_WIDTH_TRANSITION_CLASSES,
  getSidebarSurfaceBackgroundStyle,
} from "@src/modules/shared/layouts/viewContainerTokens";
import { VerticalResizeHandle } from "@src/scaffold/Resize";
import { resolvedBackgroundConfigAtom } from "@src/store/ui/backgroundConfigAtom";
import { hoverSidebarOpenAtom } from "@src/store/ui/hoverSidebarAtom";
import {
  DEFAULT_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
} from "@src/store/ui/sidebarAtom";
import { windowFullscreenAtom } from "@src/store/ui/uiAtom";
import { isTauriDesktop } from "@src/util/platform/tauri";

import { SIDEBAR_STYLE } from "./config";
import { useForceVisibleSidebar } from "./contexts/ForceVisibleContext";
import type { SidebarBaseProps } from "./types";

const log = createLogger("SidebarBase");

const HOST_DESKTOP_KIND = resolveHostDesktop();
const IS_MACOS_HOST = HOST_DESKTOP_KIND === HOST_DESKTOP.MACOS;
const IS_WINDOWS_HOST = HOST_DESKTOP_KIND === HOST_DESKTOP.WINDOWS;
const SHOW_HOST_TITLE =
  HOST_DESKTOP_KIND === HOST_DESKTOP.WINDOWS ||
  HOST_DESKTOP_KIND === HOST_DESKTOP.LINUX;

const IDLE_SIDEBAR_RESIZE_HANDLE_CLASS_NAME =
  "h-full [&>div:first-child]:origin-right [&>div:first-child]:scale-x-50 [&>div:first-child]:transition-transform hover:[&>div:first-child]:scale-x-100";

const SIDEBAR_TOP_CHROME_CLASS_NAME = "pointer-events-auto opacity-100";

// ============================================
// SidebarBase Component
// ============================================

const SidebarBase: React.FC<SidebarBaseProps> = React.memo(
  ({
    children,
    header,
    className = "",
    innerClassName = "",
    includeTrafficLightSpace = true,
    showCollapseButton = true,
    wrapInSurface = true,
    solidSurface = false,
    forceVisible: forceVisibleProp = false,
    theme,
    onCollapse,
    onAddNew,
    addIcon: AddIcon = Plus,
    addLabel,
    addTooltipContent,
    beforeAddNewActions,
    headerActions,
  }) => {
    const sidebarContainerRef = useRef<HTMLDivElement>(null);
    const {
      width: sidebarWidth,
      expandedWidth: expandedSidebarWidth,
      isDragging,
      handleMouseDown,
      isCollapsed,
      collapse,
      expand,
      setWidth,
    } = useSidebarState();
    const sidebarSelectedRowOpacity = useSettingValue(
      "layout.sidebarSelectedRowOpacity"
    );
    const sidebarEdgeDepthEnabled = useSettingValue(
      "layout.sidebarEdgeDepthEnabled"
    );
    useEffect(() => {
      document.body.style.setProperty(
        "--sidebar-selected-row-opacity",
        `${sidebarSelectedRowOpacity}%`
      );
    }, [sidebarSelectedRowOpacity]);
    const isMacOS = isTauriDesktop();
    const hideSidebarShortcut = getShortcutKeys("toggle_sidebar");
    const isFullscreen = useAtomValue(windowFullscreenAtom);
    const backgroundConfig = useAtomValue(resolvedBackgroundConfigAtom);
    const sidebarOpacityStyle = useMemo(
      () => getSidebarSurfaceBackgroundStyle(backgroundConfig.sidebarOpacity),
      [backgroundConfig.sidebarOpacity]
    );

    // Check for force visible from context (for hover sidebar)
    const forceVisibleFromContext = useForceVisibleSidebar();
    const shouldForceVisible = forceVisibleProp || forceVisibleFromContext;
    useEffect(() => {
      if (!isCollapsed || shouldForceVisible) return;
      const activeElement = document.activeElement;
      if (
        activeElement instanceof HTMLElement &&
        sidebarContainerRef.current?.contains(activeElement)
      ) {
        activeElement.blur();
      }
    }, [isCollapsed, shouldForceVisible]);

    // Check if hover sidebar is open — split read/write to avoid re-renders from setter reference
    const isHoverSidebarOpen = useAtomValue(hoverSidebarOpenAtom);
    const setIsHoverSidebarOpen = useSetAtom(hoverSidebarOpenAtom);

    // Handle collapse with optional callback
    const handleCollapse = useCallback(() => {
      // If hover sidebar is open, close it instead of collapsing
      if (isHoverSidebarOpen) {
        setIsHoverSidebarOpen(false);
        return;
      }
      collapse();
      onCollapse?.();
    }, [isHoverSidebarOpen, setIsHoverSidebarOpen, collapse, onCollapse]);

    // Handle expand - turn sidebar on permanently and close floating
    const handleExpand = useCallback(() => {
      setIsHoverSidebarOpen(false);
      expand();
    }, [setIsHoverSidebarOpen, expand]);

    const handleResizeContextMenu = useCallback(
      (event: React.MouseEvent) => {
        if (event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();

        const isAlreadyDefault = sidebarWidth === DEFAULT_SIDEBAR_WIDTH;
        const isAlreadyMin = sidebarWidth <= MIN_SIDEBAR_WIDTH;

        (async () => {
          try {
            const t = i18next.t.bind(i18next);

            const resizeDefaultItem = await MenuItem.new({
              text: t("tooltips.resizeToDefault", {
                width: DEFAULT_SIDEBAR_WIDTH,
              }),
              enabled: !isAlreadyDefault,
              action: () => {
                setWidth(DEFAULT_SIDEBAR_WIDTH);
              },
            });
            const minimizeItem = await MenuItem.new({
              text: t("tooltips.minimizeWidth", {
                width: MIN_SIDEBAR_WIDTH,
              }),
              enabled: !isAlreadyMin,
              action: () => {
                setWidth(MIN_SIDEBAR_WIDTH);
              },
            });
            const separator = await PredefinedMenuItem.new({
              item: "Separator",
            });
            const hideItem = await MenuItem.new({
              text: t("tooltips.hideSidebar"),
              action: () => {
                collapse();
              },
            });
            const menu = await TauriMenu.new({
              items: [resizeDefaultItem, minimizeItem, separator, hideItem],
            });
            await menu.popup();
          } catch (error) {
            log.error("Failed to show sidebar context menu:", error);
          }
        })();
      },
      [sidebarWidth, setWidth, collapse]
    );

    // Theme-aware styles — memoized to keep stable reference (must be before early return)
    const themeStyles = useMemo(
      () =>
        theme
          ? {
              backgroundColor: theme.background,
              borderColor: theme.border || `${theme.foreground}20`,
            }
          : undefined,
      [theme]
    );

    // Icon color style — memoized for all icon instances
    const iconThemeStyle = useMemo(
      () => (theme ? { color: `${theme.foreground}80` } : undefined),
      [theme]
    );

    // Resolve children (support render function pattern) — memoized
    const resolvedChildren = useMemo(
      () =>
        typeof children === "function" ? children(sidebarWidth) : children,
      [children, sidebarWidth]
    );

    // When forceVisible and collapsed, use default width instead of 0
    const effectiveWidth =
      shouldForceVisible && isCollapsed ? DEFAULT_SIDEBAR_WIDTH : sidebarWidth;
    const surfaceWidth =
      shouldForceVisible && isCollapsed
        ? DEFAULT_SIDEBAR_WIDTH
        : expandedSidebarWidth;

    // Memoize outer container style to avoid re-creating on every render
    const containerStyle = useMemo(
      () =>
        ({
          width: `${effectiveWidth}px`,
          willChange: isDragging ? ("width" as const) : ("auto" as const),
          pointerEvents:
            isCollapsed && !shouldForceVisible ? ("none" as const) : undefined,
          "--sidebar-selected-row-opacity": `${sidebarSelectedRowOpacity}%`,
        }) as React.CSSProperties,
      [
        effectiveWidth,
        isCollapsed,
        isDragging,
        shouldForceVisible,
        sidebarSelectedRowOpacity,
      ]
    );

    const sidebarTopChromeClassName = SIDEBAR_TOP_CHROME_CLASS_NAME;

    // Traffic lights section
    const renderTrafficLightsSpace = () => {
      if (!includeTrafficLightSpace) return null;

      // In fullscreen mode, traffic lights are hidden, so no padding needed
      const trafficLightPadding =
        IS_WINDOWS_HOST || isFullscreen
          ? 0
          : SIDEBAR_STYLE.trafficLightsPadding;
      const alignmentClassName = IS_WINDOWS_HOST
        ? "justify-between pl-5 pr-2"
        : "justify-end pr-2";

      return (
        <div
          className={`flex flex-nowrap items-center gap-1 ${alignmentClassName}`}
          data-tauri-drag-region
          style={
            {
              height: `${SIDEBAR_STYLE.topBarHeight}px`,
              paddingLeft: IS_WINDOWS_HOST
                ? undefined
                : `${trafficLightPadding}px`,
              WebkitAppRegion: IS_WINDOWS_HOST ? "no-drag" : "drag",
            } as React.CSSProperties
          }
        >
          {SHOW_HOST_TITLE ? (
            <span className="select-none text-[13px] font-semibold tracking-wide text-text-2">
              ORG2
            </span>
          ) : null}
          <div
            className={`flex items-center gap-1 ${sidebarTopChromeClassName}`}
          >
            {beforeAddNewActions ? (
              <div
                style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
              >
                {beforeAddNewActions}
              </div>
            ) : null}

            {/* Top action button */}
            {onAddNew && (
              <div
                className="shrink-0"
                style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
              >
                <Tooltip
                  content={
                    addTooltipContent ||
                    addLabel ||
                    i18next.t("navigation:sidebar.actions.addNew")
                  }
                  position="bottom"
                  showArrow={false}
                  framedPanel={!!addTooltipContent}
                >
                  <div
                    className="h-[28px] w-[28px]"
                    onClick={onAddNew}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onAddNew();
                      }
                    }}
                    role="button"
                    tabIndex={0}
                  >
                    <div className="flex h-[28px] w-[28px] cursor-pointer items-center justify-center rounded-[100px] transition-colors duration-150 hover:bg-sidebar-selected">
                      <AddIcon
                        size={16}
                        strokeWidth={2}
                        className="text-text-2"
                        style={iconThemeStyle}
                      />
                    </div>
                  </div>
                </Tooltip>
              </div>
            )}

            {headerActions ? (
              <div
                style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
              >
                {headerActions}
              </div>
            ) : null}

            {/* Collapse/Expand buttons */}
            <div
              className="flex shrink-0 items-center gap-1"
              style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
            >
              {isMacOS && showCollapseButton ? (
                isHoverSidebarOpen ? (
                  <>
                    {/* Expand sidebar permanently button */}
                    <button
                      type="button"
                      className="flex h-[28px] w-[28px] cursor-pointer items-center justify-center rounded-[100px] border-none bg-transparent p-0 transition-colors duration-150 hover:bg-sidebar-selected"
                      onClick={handleExpand}
                    >
                      <PanelLeft
                        size={16}
                        strokeWidth={2}
                        className="text-text-2"
                        style={iconThemeStyle}
                      />
                    </button>
                    {/* Close floating sidebar button */}
                    <button
                      type="button"
                      className="flex h-[28px] w-[28px] cursor-pointer items-center justify-center rounded-[100px] border-none bg-transparent p-0 transition-colors duration-150 hover:bg-sidebar-selected"
                      onClick={handleCollapse}
                    >
                      <X
                        size={16}
                        strokeWidth={2}
                        className="text-text-2"
                        style={iconThemeStyle}
                      />
                    </button>
                  </>
                ) : (
                  <Tooltip
                    content={
                      <KeyboardShortcutTooltipContent
                        label={i18next.t("common:tooltips.hideSidebar")}
                        shortcut={hideSidebarShortcut}
                      />
                    }
                    position="bottom"
                    mouseEnterDelay={200}
                    framedPanel
                  >
                    <div className="inline-flex">
                      <button
                        type="button"
                        className="flex h-[28px] w-[28px] cursor-pointer items-center justify-center rounded-[100px] border-none bg-transparent p-0 transition-colors duration-150 hover:bg-sidebar-selected"
                        onClick={handleCollapse}
                      >
                        <PanelLeft
                          size={16}
                          strokeWidth={2}
                          className="text-text-2"
                          style={iconThemeStyle}
                        />
                      </button>
                    </div>
                  </Tooltip>
                )
              ) : (
                <div className="h-[28px] w-[28px]" />
              )}
            </div>
          </div>
        </div>
      );
    };

    const renderResizeHandle = () => (
      <div
        className="absolute right-0 top-0 z-50 h-full"
        style={{ pointerEvents: "auto" }}
      >
        <VerticalResizeHandle
          className={IDLE_SIDEBAR_RESIZE_HANDLE_CLASS_NAME}
          isResizing={isDragging}
          onMouseDown={handleMouseDown}
          onContextMenu={handleResizeContextMenu}
          variant="border"
        />
      </div>
    );

    // Content
    // Modern layout: the sidebar surface itself reaches the top window edge
    // (no outer `pt-2`), so we move the 8px top breathing room inside via a
    // spacer div. This keeps the header / icons at the same vertical position
    // as the previous alternatives while letting the surface cover the full sidebar column.
    const content = (
      <>
        {wrapInSurface && (
          <div
            className="h-2 flex-shrink-0"
            data-tauri-drag-region
            style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
            aria-hidden
          />
        )}
        {renderTrafficLightsSpace()}
        {header}
        <div className="flex flex-1 flex-col overflow-hidden">
          {resolvedChildren}
        </div>
      </>
    );

    // Modern layout: the sidebar is flush with the rounded window edge
    // (top-left + bottom-left curves match `--border-radius-window`). Avoid
    // a broad docked drop shadow because it traces the window corner. On
    // macOS, use a narrow inset edge shadow instead: it creates the vertical
    // Codex-style depth where the sidebar meets the content panel without
    // bleeding outside the rounded clip.
    //
    // Floating / hover sidebar: it pops out over the workspace content as
    // a transient overlay. It should feel solid (so it's legible against
    // whatever's behind it) and should ignore the user's sidebarOpacity
    // setting. We paint `--color-bg-1` (the design-system solid raised
    // surface) and keep the floating drop shadow regardless of the
    // current layout mode so it visually detaches from the workspace.
    const sidebarBoxShadow = shouldForceVisible
      ? "var(--sidebar-shadow)"
      : IS_MACOS_HOST && sidebarEdgeDepthEnabled
        ? "var(--sidebar-edge-shadow)"
        : "none";
    const sidebarBackdropFilter = "none";
    const floatingSurfaceOverride: React.CSSProperties = shouldForceVisible
      ? { backgroundColor: "var(--color-bg-1)" }
      : {};
    const surfaceStyle = themeStyles
      ? {
          ...themeStyles,
          boxShadow: sidebarBoxShadow,
          backdropFilter: sidebarBackdropFilter,
          WebkitBackdropFilter: sidebarBackdropFilter,
          ...floatingSurfaceOverride,
        }
      : {
          backgroundColor: "var(--sidebar-bg)",
          borderColor: "var(--sidebar-border)",
          boxShadow: sidebarBoxShadow,
          backdropFilter: sidebarBackdropFilter,
          WebkitBackdropFilter: sidebarBackdropFilter,
          ...(IS_WINDOWS_HOST || shouldForceVisible || solidSurface
            ? {}
            : sidebarOpacityStyle),
          ...floatingSurfaceOverride,
        };

    // Wrapped content
    // Modern layout: sidebar is flush with the top/left/bottom window edge —
    // no outer padding, no border radius on the right (it butts against the
    // content panel). The top-left and bottom-left corners follow the window
    // radius (`--border-radius-window`) so the sidebar surface aligns with
    // the rounded window/body clip instead of leaving a sliver of the body
    // Modern chrome keeps the sidebar flush against the rounded window edge,
    // with only a separator where it meets the content panel.
    const modernSurfaceStyle = {
      borderTopLeftRadius: "var(--border-radius-window)",
      borderBottomLeftRadius: "var(--border-radius-window)",
      borderTopRightRadius: 0,
      borderBottomRightRadius: 0,
      borderTopWidth: 0,
      borderLeftWidth: 0,
      borderBottomWidth: 0,
      borderRightWidth: 1,
    } as const;
    const wrappedContent = wrapInSurface ? (
      <div
        className={`sidebar-base flex h-full w-full flex-col overflow-hidden ${innerClassName}`}
      >
        <div
          className="flex h-full flex-none flex-col overflow-hidden"
          style={{
            ...surfaceStyle,
            ...modernSurfaceStyle,
            width: `${surfaceWidth}px`,
          }}
        >
          {content}
        </div>
      </div>
    ) : (
      <div
        className={`sidebar-base flex h-full w-full flex-col ${innerClassName}`}
        style={themeStyles}
      >
        {content}
      </div>
    );

    return (
      <div
        ref={sidebarContainerRef}
        className={`group/sidebar relative flex h-full flex-shrink-0 ${
          isDragging ? "" : PANE_WIDTH_TRANSITION_CLASSES
        } ${className}`}
        style={containerStyle}
        aria-hidden={isCollapsed && !shouldForceVisible}
        data-sidebar-collapsed={isCollapsed || undefined}
        onContextMenu={handleResizeContextMenu}
      >
        {wrappedContent}
        {(!isCollapsed || shouldForceVisible) && renderResizeHandle()}
      </div>
    );
  }
);

SidebarBase.displayName = "SidebarBase";

export default SidebarBase;
