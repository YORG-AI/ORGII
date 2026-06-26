/**
 * ContextMenuPortal
 *
 * Renders the @ mention context menu via a React portal
 * to avoid clipping by parent overflow containers.
 */
import {
  type MenuItemId,
  type RecentFile,
} from "@/src/scaffold/ContextMenu/config";
import { ContextMenu } from "@/src/scaffold/ContextMenu/exports";
import type {
  ContextMenuCustomMentionOption,
  ContextMenuProps,
} from "@/src/scaffold/ContextMenu/types";
import { useAtomValue } from "jotai";
import React, { useMemo, useRef } from "react";
import { createPortal } from "react-dom";

import {
  type WorkStationTab,
  mainPaneTabsAtom,
} from "@src/store/workstation/tabs";

import { getOpenedTabMentionOptions } from "../openedTabMentionOptions";
import type { FloatingPlacementStrategy } from "./floatingPlacement";
import { useFloatingPortalPosition } from "./useFloatingPortalPosition";

interface ContextMenuPortalProps {
  visible: boolean;
  containerRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onSelect: (type: MenuItemId, value?: string, displayName?: string) => void;
  customMentionOptions?: ReadonlyArray<ContextMenuCustomMentionOption>;
  onCustomMentionSelect?: (option: ContextMenuCustomMentionOption) => void;
  searchQuery: string;
  inlineSearchOnEmpty?: boolean;
  keyboardOpened?: boolean;
  repoPath?: string;
  keyboardHandlerRef: React.MutableRefObject<
    ((e: React.KeyboardEvent) => boolean) | null
  >;
  treePosition?: ContextMenuProps["treePosition"];
  placement?: FloatingPlacementStrategy;
  /** Optional descendant of containerRef to anchor the menu against. */
  anchorSelector?: string;
}

const ESTIMATED_DROPDOWN_HEIGHT = 260;
const MAX_CONTEXT_MENU_WIDTH = 600;

function getOpenedTabRecentFiles(
  workstationTabs: ReadonlyArray<WorkStationTab>
): RecentFile[] {
  return workstationTabs
    .filter(
      (tab) => tab.type === "file" && typeof tab.data.filePath === "string"
    )
    .map((tab) => ({
      path: tab.data.filePath as string,
      name: tab.title,
      type: "file" as const,
    }));
}

function getMentionOptionTargetKey(
  option: ContextMenuCustomMentionOption
): string {
  return `${option.selectType}:${option.selectValue}`;
}

function mergeCustomMentionOptions(
  primaryOptions: ReadonlyArray<ContextMenuCustomMentionOption>,
  secondaryOptions: ReadonlyArray<ContextMenuCustomMentionOption> = []
): ContextMenuCustomMentionOption[] {
  const merged: ContextMenuCustomMentionOption[] = [];
  const seenTargets = new Set<string>();
  for (const option of [...primaryOptions, ...secondaryOptions]) {
    const targetKey = getMentionOptionTargetKey(option);
    if (seenTargets.has(targetKey)) continue;
    seenTargets.add(targetKey);
    merged.push(option);
  }
  return merged;
}

const VisibleContextMenuPortal: React.FC<
  Omit<ContextMenuPortalProps, "visible">
> = ({
  containerRef,
  onClose,
  onSelect,
  customMentionOptions,
  onCustomMentionSelect,
  searchQuery,
  inlineSearchOnEmpty,
  keyboardOpened,
  repoPath,
  keyboardHandlerRef,
  treePosition = "right",
  placement = "prefer-up",
  anchorSelector,
}) => {
  const portalRef = useRef<HTMLDivElement>(null);
  const workstationTabs = useAtomValue(mainPaneTabsAtom);
  const recentFiles = useMemo(
    () => getOpenedTabRecentFiles(workstationTabs),
    [workstationTabs]
  );
  const mergedCustomMentionOptions = useMemo(
    () =>
      mergeCustomMentionOptions(
        customMentionOptions ?? [],
        getOpenedTabMentionOptions(workstationTabs)
      ),
    [workstationTabs, customMentionOptions]
  );
  const { portalPosition, portalWidth, isPositioned } =
    useFloatingPortalPosition({
      visible: true,
      containerRef,
      floatingRef: portalRef,
      fallbackHeight: ESTIMATED_DROPDOWN_HEIGHT,
      placement,
      anchorSelector,
      updateKey: searchQuery,
      maxWidth: MAX_CONTEXT_MENU_WIDTH,
    });

  if (!isPositioned || !portalPosition) return null;

  return createPortal(
    // data-context-menu-portal lets the click-outside handler in
    // useInputAreaEffects recognise clicks anywhere in this shell (including
    // the paddingBottom gap) as "inside the menu", preventing spurious close.
    <div
      ref={portalRef}
      data-context-menu-portal
      className={`fixed z-[99999] ${
        portalPosition.placement === "down" ? "pt-0" : "pb-0"
      }`}
      style={{
        top: portalPosition.top,
        bottom: portalPosition.bottom,
        left: portalPosition.left,
        width: portalWidth,
      }}
    >
      <ContextMenu
        visible
        onClose={onClose}
        onSelect={onSelect}
        customMentionOptions={mergedCustomMentionOptions}
        onCustomMentionSelect={onCustomMentionSelect}
        searchQuery={searchQuery}
        inlineSearchOnEmpty={inlineSearchOnEmpty}
        keyboardOpened={keyboardOpened}
        recentFiles={recentFiles}
        repoPath={repoPath}
        keyboardHandlerRef={keyboardHandlerRef}
        treePosition={treePosition}
      />
    </div>,
    document.body
  );
};

const ContextMenuPortal: React.FC<ContextMenuPortalProps> = ({
  visible,
  ...props
}) => {
  if (!visible) return null;
  return <VisibleContextMenuPortal {...props} />;
};

ContextMenuPortal.displayName = "ContextMenuPortal";

export default ContextMenuPortal;
