/**
 * FileSidebar Component
 *
 * Full-height sidebar for the IDE view with tree-based file navigation.
 * Uses VirtualizedStickyTree + TreeRowBase for visual consistency
 * with the main code editor's file explorer.
 *
 * Shows files read/edited and search operations
 * up to the current replay point via tab-specific tree panels.
 */
import { Compass, GitBranch, List, ListTree, Terminal } from "lucide-react";
import React, { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { SectionHeaderAction } from "@src/components/TreePanelSidebar/types";
import { resolveToolName } from "@src/engines/SessionCore/rendering/registry/toolAliases";
import { formatToolArg } from "@src/util/ui/rendering/formatToolName";
import { getToolDisplayLabelFromRegistry } from "@src/util/ui/rendering/registryToolLabel";

import { PrimarySidebarLayoutWithSections } from "../../shared";
import type { PrimarySidebarTab } from "../../shared/PrimarySidebarLayout/PrimarySidebarLayoutWithSections";
import {
  type ActiveSelectionKind,
  gateByActiveKind,
} from "../../shared/SessionReplay";
import { PANEL_CONSTANTS } from "../Panels/EditorPrimarySidebar/config";
import { getShellStatusBadge } from "./ShellSidebar";
import SimulatorTreePanel from "./components/SimulatorTreePanel";
import type { FileTreeInput } from "./fileTreeUtils";
import { resolveFileOperationPayload } from "./resolveFilePayload";
import type {
  ExploreOperationEntry,
  FileOperationEntry,
  FilePanelViewMode,
  ShellOperationEntry,
  ToolOperationEntry,
} from "./types";
import { FILE_OPERATION_TYPE, FILE_PANEL_VIEW_MODE } from "./types";
import { getExploreDisplayName } from "./utils/exploreDisplayUtils";
import { getWriteStatusBadge, sidebarToolIcon } from "./utils/fileOpUtils";

// ============================================
// Types
// ============================================

interface FileSidebarProps {
  fileViewMode: FilePanelViewMode;
  onFileViewModeChange: (mode: FilePanelViewMode) => void;
  fileOperations: FileOperationEntry[];
  exploreOperations: ExploreOperationEntry[];
  shellOperations: ShellOperationEntry[];
  toolOperations: ToolOperationEntry[];
  selectedFileEventId: string | null;
  selectedExploreEventId: string | null;
  selectedShellEventId: string | null;
  selectedToolEventId: string | null;
  /** Kind of selection currently displayed in CodePanel; gates highlight fill. */
  activeSelectionKind: ActiveSelectionKind;
  onSelectFileOperation: (eventId: string) => void;
  onSelectExploreOperation: (eventId: string) => void;
  onSelectShellOperation: (eventId: string) => void;
  onSelectToolOperation: (eventId: string) => void;
  currentEventId: string;
  width?: number;
}

// ============================================
// FileSidebar Component
// ============================================

const FileSidebarComponent: React.FC<FileSidebarProps> = ({
  fileViewMode,
  onFileViewModeChange,
  fileOperations,
  exploreOperations,
  shellOperations,
  toolOperations,
  selectedFileEventId,
  selectedExploreEventId,
  selectedShellEventId,
  selectedToolEventId,
  activeSelectionKind,
  onSelectFileOperation,
  onSelectExploreOperation,
  onSelectShellOperation,
  onSelectToolOperation,
  currentEventId,
  width,
}) => {
  const { t } = useTranslation("sessions");

  const [fileOperationsViewMode, setFileOperationsViewMode] = useState<
    "list-tree" | "list"
  >("list");

  const handleFileOperationsViewModeToggle = useCallback(() => {
    setFileOperationsViewMode((previous) =>
      previous === "list-tree" ? "list" : "list-tree"
    );
  }, []);

  const fileOperationsSectionActions = useMemo<SectionHeaderAction[]>(
    () => [
      {
        key: "simulator-file-view-mode",
        icon:
          fileOperationsViewMode === "list" ? (
            <ListTree
              size={PANEL_CONSTANTS.ACTION_ICON_SIZE}
              strokeWidth={PANEL_CONSTANTS.ACTION_ICON_STROKE}
            />
          ) : (
            <List
              size={PANEL_CONSTANTS.ACTION_ICON_SIZE}
              strokeWidth={PANEL_CONSTANTS.ACTION_ICON_STROKE}
            />
          ),
        tooltip:
          fileOperationsViewMode === "list-tree"
            ? t("simulator.codeEditor.switchToListView")
            : t("simulator.codeEditor.switchToTreeView"),
        onClick: handleFileOperationsViewModeToggle,
      },
    ],
    [fileOperationsViewMode, handleFileOperationsViewModeToggle, t]
  );

  // --- Stable tree items ---
  // Separate the tree structure (file paths, names, badges) from the
  // agent-selection highlight.  Tree items use a stable string key so
  // buildFileTree / flattenFileTree only re-run when the actual file set
  // changes, NOT on every currentEventId navigation.

  const readOperations = useMemo(
    () => fileOperations.filter((op) => op.type === FILE_OPERATION_TYPE.READ),
    [fileOperations]
  );

  const readFileKey = useMemo(
    () => readOperations.map((op) => op.eventId).join(","),
    [readOperations]
  );

  const readItems: FileTreeInput[] = useMemo(
    () =>
      readOperations.map((op) => ({
        id: op.eventId,
        filePath: op.filePath,
        fileName: op.fileName,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by readFileKey
    [readFileKey]
  );

  const writeOperations = useMemo(
    () =>
      fileOperations.filter(
        (op) =>
          op.type === FILE_OPERATION_TYPE.WRITE ||
          op.type === FILE_OPERATION_TYPE.DELETE
      ),
    [fileOperations]
  );

  const writeFileKey = useMemo(
    () =>
      writeOperations
        .map((op) => {
          if (op.type === FILE_OPERATION_TYPE.DELETE) {
            return `${op.eventId}:D`;
          }
          const hasBaseline =
            op.writeHasBaselineContent !== undefined
              ? op.writeHasBaselineContent
              : Boolean(resolveFileOperationPayload(op).oldContent);
          return `${op.eventId}:${hasBaseline ? "M" : "A"}`;
        })
        .join(","),
    [writeOperations]
  );

  const writeItems: FileTreeInput[] = useMemo(
    () =>
      writeOperations.map((op) => {
        const badge = getWriteStatusBadge(op);
        return {
          id: op.eventId,
          filePath: op.filePath,
          fileName: op.fileName,
          statusLabel: badge?.label,
          statusColorClass: badge?.colorClass,
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by writeFileKey
    [writeFileKey]
  );

  const exploreItems: FileTreeInput[] = useMemo(
    () =>
      exploreOperations.map((op) => ({
        id: op.eventId,
        filePath: encodeURIComponent(op.eventId),
        fileName: getExploreDisplayName(op),
        icon: sidebarToolIcon(op.event?.functionName),
      })),
    [exploreOperations]
  );

  const shellItemsKey = useMemo(
    () => shellOperations.map((op) => op.eventId).join(","),
    [shellOperations]
  );

  const shellItems: FileTreeInput[] = useMemo(
    () =>
      shellOperations.map((op) => {
        const badge = getShellStatusBadge(op);
        return {
          id: op.eventId,
          filePath: encodeURIComponent(op.eventId),
          fileName: op.commandKeywords || op.shortCommand,
          icon: sidebarToolIcon(op.event?.functionName || "run_shell"),
          statusLabel: badge?.text,
          statusColorClass: badge?.className,
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by shellItemsKey
    [shellItemsKey]
  );

  const toolItems: FileTreeInput[] = useMemo(
    () =>
      toolOperations.map((op) => {
        const label = getToolDisplayLabelFromRegistry(
          resolveToolName(op.toolName)
        );
        const arg = formatToolArg(
          op.toolName,
          op.event?.args as Record<string, unknown> | undefined
        );
        return {
          id: op.eventId,
          filePath: encodeURIComponent(op.eventId),
          fileName: arg ? `${label} · ${arg}` : label,
          icon: sidebarToolIcon(op.toolName),
        };
      }),
    [toolOperations]
  );

  // --- Agent-selection highlight ---
  // Cheap Set rebuilt every navigation; only affects the blue dot in renderItem,
  // never triggers tree reconstruction.
  const agentSelectedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const op of fileOperations) {
      if (
        op.eventId === currentEventId ||
        op.isCurrent ||
        (currentEventId && op.relatedEventIds?.includes(currentEventId))
      ) {
        ids.add(op.eventId);
      }
    }
    for (const op of exploreOperations) {
      if (op.eventId === currentEventId) {
        ids.add(op.eventId);
      }
    }
    for (const op of shellOperations) {
      if (op.eventId === currentEventId) {
        ids.add(op.eventId);
      }
    }
    for (const op of toolOperations) {
      if (op.eventId === currentEventId) {
        ids.add(op.eventId);
      }
    }
    return ids;
  }, [
    fileOperations,
    exploreOperations,
    shellOperations,
    toolOperations,
    currentEventId,
  ]);

  // Single-source gating: only the section whose kind matches activeSelectionKind
  // shows the primary-1 row fill; everything else is nulled. See activeSelection.ts
  // for rationale. Agent dot (agentSelectedIds) is independent and unaffected.
  const {
    file: fileSectionSelectedId,
    explore: exploreSectionSelectedId,
    terminal: shellSectionSelectedId,
    tool: toolSectionSelectedId,
  } = gateByActiveKind(
    {
      file: selectedFileEventId,
      explore: selectedExploreEventId,
      terminal: selectedShellEventId,
      tool: selectedToolEventId,
    },
    activeSelectionKind
  );

  const tabs: PrimarySidebarTab[] = useMemo(
    () => [
      {
        key: FILE_PANEL_VIEW_MODE.EXPLORE,
        label: t("simulator.replay.ide.fileSidebar.tabExplore"),
        icon: <Compass size={PANEL_CONSTANTS.TAB_ICON_SIZE} />,
        sections: [
          {
            key: "files-read",
            title: t("simulator.replay.ide.fileSidebar.sectionFilesRead"),
            content: (
              <SimulatorTreePanel
                key={`simulator-read-${fileOperationsViewMode}`}
                items={readItems}
                selectedId={fileSectionSelectedId}
                agentSelectedIds={agentSelectedIds}
                onSelectItem={onSelectFileOperation}
                emptyMessage={t(
                  "simulator.replay.ide.fileSidebar.emptyNoFilesRead"
                )}
                viewMode={fileOperationsViewMode}
              />
            ),
            defaultFlexGrow: 2,
            resizable: true,
            actions:
              readItems.length > 0 ? fileOperationsSectionActions : undefined,
          },
          {
            key: "explorations",
            title: t("simulator.replay.ide.fileSidebar.sectionExplorations"),
            content: (
              <SimulatorTreePanel
                items={exploreItems}
                selectedId={exploreSectionSelectedId}
                agentSelectedIds={agentSelectedIds}
                onSelectItem={onSelectExploreOperation}
                emptyMessage={t(
                  "simulator.replay.ide.fileSidebar.emptyNoExploreOperations"
                )}
                viewMode="list-tree"
              />
            ),
            defaultFlexGrow: 1,
            resizable: true,
          },
        ],
      },
      {
        key: FILE_PANEL_VIEW_MODE.WRITE,
        label: t("simulator.replay.ide.fileSidebar.tabEdit"),
        icon: <GitBranch size={PANEL_CONSTANTS.TAB_ICON_SIZE} />,
        sections: [
          {
            key: "files-edited",
            title: t("simulator.replay.ide.fileSidebar.sectionFilesEdited"),
            content: (
              <SimulatorTreePanel
                key={`simulator-write-${fileOperationsViewMode}`}
                items={writeItems}
                selectedId={fileSectionSelectedId}
                agentSelectedIds={agentSelectedIds}
                onSelectItem={onSelectFileOperation}
                emptyMessage={t(
                  "simulator.replay.ide.fileSidebar.emptyNoFilesEdited"
                )}
                viewMode={fileOperationsViewMode}
              />
            ),
            defaultFlexGrow: 1,
            resizable: false,
            actions:
              writeItems.length > 0 ? fileOperationsSectionActions : undefined,
          },
        ],
      },
      {
        key: FILE_PANEL_VIEW_MODE.TERMINAL,
        label: t("simulator.replay.ide.fileSidebar.tabTerminal"),
        icon: <Terminal size={PANEL_CONSTANTS.TAB_ICON_SIZE} />,
        sections: [
          {
            key: "shell-commands",
            title: t("simulator.replay.ide.fileSidebar.sectionCommands"),
            content: (
              <SimulatorTreePanel
                items={shellItems}
                selectedId={shellSectionSelectedId}
                agentSelectedIds={agentSelectedIds}
                onSelectItem={onSelectShellOperation}
                emptyMessage={t(
                  "simulator.replay.ide.fileSidebar.emptyNoCommands"
                )}
                viewMode="list-tree"
              />
            ),
            defaultFlexGrow: 1,
            resizable: false,
          },
          {
            key: "other-tools",
            title: t("simulator.replay.ide.fileSidebar.sectionOtherTools"),
            content: (
              <SimulatorTreePanel
                items={toolItems}
                selectedId={toolSectionSelectedId}
                agentSelectedIds={agentSelectedIds}
                onSelectItem={onSelectToolOperation}
                emptyMessage={t(
                  "simulator.replay.ide.fileSidebar.emptyNoToolCalls"
                )}
                viewMode="list-tree"
              />
            ),
            defaultFlexGrow: 1,
            resizable: true,
          },
        ],
      },
    ],
    [
      readItems,
      writeItems,
      exploreItems,
      shellItems,
      toolItems,
      fileSectionSelectedId,
      exploreSectionSelectedId,
      shellSectionSelectedId,
      toolSectionSelectedId,
      agentSelectedIds,
      onSelectFileOperation,
      onSelectExploreOperation,
      onSelectShellOperation,
      onSelectToolOperation,
      fileOperationsViewMode,
      fileOperationsSectionActions,
      t,
    ]
  );

  const handleTabChange = useMemo(
    () => (tab: string) => onFileViewModeChange(tab as FilePanelViewMode),
    [onFileViewModeChange]
  );

  const containerStyle =
    width !== undefined ? { width: `${width}px` } : undefined;

  return (
    <div
      className="flex h-full min-h-0 w-full min-w-0 flex-col"
      style={containerStyle}
    >
      <PrimarySidebarLayoutWithSections
        tabs={tabs}
        activeTab={fileViewMode}
        onTabChange={handleTabChange}
        tabIconOnly={true}
      />
    </div>
  );
};

export const FileSidebar = memo(FileSidebarComponent);
FileSidebar.displayName = "FileSidebar";

export default FileSidebar;
