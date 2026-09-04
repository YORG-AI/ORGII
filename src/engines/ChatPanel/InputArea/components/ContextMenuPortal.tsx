/**
 * ContextMenuPortal
 *
 * Renders the shared + / @ context menu via a React portal
 * to avoid clipping by parent overflow containers.
 */
import {
  type MenuItemId,
  type RecentFile,
} from "@/src/scaffold/ContextMenu/config";
import { ContextMenu } from "@/src/scaffold/ContextMenu/exports";
import type { ContextMenuCustomMentionOption } from "@/src/scaffold/ContextMenu/types";
import { useAtomValue } from "jotai";
import React, { useCallback, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { INPUT_AREA_MENU_FRAME } from "@src/config/inputAreaTokens";
import type { ComposerModeEntry } from "@src/config/sessionCreatorConfig";
import WorkItemPickerModal, {
  type WorkItemPickerOption,
} from "@src/features/SessionCreator/components/WorkItemPickerModal";
import {
  type WorkStationTab,
  mainPaneTabsAtom,
} from "@src/store/workstation/tabs";

import {
  getOpenedTabMentionOptions,
  mergeCustomMentionOptions,
} from "../openedTabMentionOptions";
import { usePathTreePosition } from "./pathTreePosition";
import { useFloatingPortalPosition } from "./useFloatingPortalPosition";

interface ContextMenuPortalProps {
  visible: boolean;
  containerRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  onSelect: (type: MenuItemId, value?: string, displayName?: string) => void;
  onImageUpload?: () => void;
  currentMode: ComposerModeEntry["id"];
  onModeSelect: (mode: ComposerModeEntry["id"]) => void;
  includeProjectMode?: boolean;
  customMentionOptions?: ReadonlyArray<ContextMenuCustomMentionOption>;
  onCustomMentionSelect?: (option: ContextMenuCustomMentionOption) => void;
  searchQuery: string;
  repoPath?: string;
  keyboardHandlerRef: React.MutableRefObject<
    ((e: React.KeyboardEvent) => boolean) | null
  >;
  /** Optional descendant of containerRef to anchor the menu against. */
  anchorSelector?: string;
}

const ESTIMATED_DROPDOWN_HEIGHT = 260;

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

const VisibleContextMenuPortal: React.FC<
  Omit<ContextMenuPortalProps, "visible">
> = ({
  containerRef,
  onClose,
  onSelect,
  onImageUpload,
  currentMode,
  onModeSelect,
  includeProjectMode,
  customMentionOptions,
  onCustomMentionSelect,
  searchQuery,
  repoPath,
  keyboardHandlerRef,
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
  const treePosition = usePathTreePosition();
  const { portalPosition, portalWidth, isPositioned } =
    useFloatingPortalPosition({
      visible: true,
      containerRef,
      floatingRef: portalRef,
      fallbackHeight: ESTIMATED_DROPDOWN_HEIGHT,
      ...INPUT_AREA_MENU_FRAME,
      anchorSelector,
      updateKey: searchQuery,
    });

  if (!isPositioned || !portalPosition) return null;

  return createPortal(
    // data-context-menu-portal lets the click-outside handler in
    // useInputAreaEffects recognise clicks anywhere in this shell (including
    // the paddingBottom gap) as "inside the menu", preventing spurious close.
    <div
      ref={portalRef}
      data-context-menu-portal
      className={`fixed z-99999 ${
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
        onImageUpload={onImageUpload}
        currentMode={currentMode}
        onModeSelect={onModeSelect}
        includeProjectMode={includeProjectMode}
        customMentionOptions={mergedCustomMentionOptions}
        onCustomMentionSelect={onCustomMentionSelect}
        searchQuery={searchQuery}
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
  onClose,
  onSelect,
  repoPath,
  ...props
}) => {
  const [workItemPickerOpen, setWorkItemPickerOpen] = useState(false);
  const handleContextSelect = useCallback(
    (type: MenuItemId, value?: string, displayName?: string) => {
      if (type === "projects") {
        setWorkItemPickerOpen(true);
        return;
      }
      onSelect(type, value, displayName);
    },
    [onSelect]
  );
  const handleWorkItemPickerClose = useCallback(
    () => setWorkItemPickerOpen(false),
    []
  );
  const handleWorkItemPickerSelect = useCallback(
    (options: readonly WorkItemPickerOption[]) => {
      for (const option of options) {
        if (option.kind === "workitem") {
          onSelect("workitem", option.pillPath, option.pillName);
        }
      }
      setWorkItemPickerOpen(false);
    },
    [onSelect]
  );

  return (
    <>
      {visible ? (
        <VisibleContextMenuPortal
          {...props}
          onClose={onClose}
          onSelect={handleContextSelect}
          repoPath={repoPath}
        />
      ) : null}
      <WorkItemPickerModal
        open={workItemPickerOpen}
        onClose={handleWorkItemPickerClose}
        onSelect={handleWorkItemPickerSelect}
        multiple={false}
        repoPath={repoPath}
        sourceFilters={["workitem"]}
      />
    </>
  );
};

ContextMenuPortal.displayName = "ContextMenuPortal";

export default ContextMenuPortal;
