/**
 * ProblemsContent Component
 *
 * Displays lint/TypeScript errors with click-to-navigate functionality.
 * Similar to VS Code's Problems panel.
 * Shows diagnostic source health status when no problems are detected.
 *
 * Uses VirtualizedStickyTree for efficient rendering of large diagnostic lists.
 */
import { useAtomValue } from "jotai";
import { ChevronDown, ChevronRight } from "lucide-react";
import React, { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import FileTypeIcon from "@src/components/FileTypeIcon";
import { TreeRowBase } from "@src/components/TreeRow";
import {
  TREE_GUIDE_OFFSET_BASE,
  TREE_INDENT_GUIDE_CLASS,
  TREE_INDENT_PX,
  TREE_PADDING_X,
  TREE_ROW_HEIGHT,
} from "@src/components/TreeRow/config";
import {
  type FlattenedTreeNode,
  VirtualizedStickyTree,
} from "@src/components/VirtualizedStickyTree";
import { SURFACE_TOKENS } from "@src/config/surfaceTokens";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import { editorShowTreeIndentGuidesAtom } from "@src/store/ui/editorSettingsAtom";

import { HealthStatusDisplay } from "./HealthStatusDisplay";
import {
  flattenProblemsTree,
  formatDiagnosticLocationSuffix,
  getSeverityIcon,
  groupDiagnosticsByFile,
} from "./problemsUtils";
import type { ProblemsNode } from "./problemsUtils";
import type { Diagnostic } from "./types";

// ============================================
// Types
// ============================================

export interface ProblemsContentProps {
  diagnostics: Diagnostic[];
  onDiagnosticClick?: (diagnostic: Diagnostic) => void;
  onClearAll?: () => void;
  collapsedFiles?: Set<string>;
  onToggleFileGroup?: (filePath: string) => void;
  isScanning?: boolean;
  className?: string;
}

const FILE_HEADER_ROW_HEIGHT = TREE_ROW_HEIGHT;

const TREE_ROW_CHEVRON_CELL_PX = 16;
const TREE_ROW_ICON_GAP_PX = 6;

const PROBLEMS_DIAGNOSTIC_ROW_PADDING_LEFT_PX =
  TREE_PADDING_X + TREE_ROW_CHEVRON_CELL_PX + TREE_ROW_ICON_GAP_PX;

// ============================================
// Sub-Components
// ============================================

const CountBadge: React.FC<{
  count: number;
  variant: "error" | "warning";
}> = memo(({ count, variant }) => (
  <span
    className={`flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[11px] font-medium text-white ${
      variant === "error" ? "bg-danger-5" : "bg-warning-5"
    }`}
  >
    {count}
  </span>
));
CountBadge.displayName = "CountBadge";

// ============================================
// Main Component
// ============================================

export const ProblemsContent: React.FC<ProblemsContentProps> = memo(
  ({
    diagnostics,
    onDiagnosticClick,
    onClearAll: _onClearAll,
    collapsedFiles: controlledCollapsedFiles,
    onToggleFileGroup: controlledToggleFileGroup,
    isScanning = false,
    className = "",
  }) => {
    const { t } = useTranslation();
    const indentGuidesEnabled = useAtomValue(editorShowTreeIndentGuidesAtom);
    const [selectedDiagnosticId, setSelectedDiagnosticId] = useState<
      string | null
    >(null);

    const [internalCollapsedFiles, setInternalCollapsedFiles] = useState<
      Set<string>
    >(new Set());

    const collapsedFiles = controlledCollapsedFiles ?? internalCollapsedFiles;

    const toggleFileGroup = useCallback(
      (filePath: string) => {
        if (controlledToggleFileGroup) {
          controlledToggleFileGroup(filePath);
        } else {
          setInternalCollapsedFiles((prev) => {
            const next = new Set(prev);
            if (next.has(filePath)) next.delete(filePath);
            else next.add(filePath);
            return next;
          });
        }
      },
      [controlledToggleFileGroup]
    );

    const groupedDiagnostics = useMemo(
      () => groupDiagnosticsByFile(diagnostics),
      [diagnostics]
    );

    const flattenedNodes = useMemo(
      () => flattenProblemsTree(groupedDiagnostics, collapsedFiles),
      [groupedDiagnostics, collapsedFiles]
    );

    const renderItem = useCallback(
      (item: FlattenedTreeNode<ProblemsNode>) => {
        const { node, depth } = item;

        if (node.nodeType === "file-header" && node.group) {
          const group = node.group;
          return (
            <TreeRowBase
              node={{
                id: group.filePath,
                name: group.fileName,
                path: group.filePath,
                type: "directory",
                expanded: group.expanded,
                icon: (
                  <div className="flex h-4 w-4 items-center justify-center">
                    {group.expanded ? (
                      <ChevronDown size={14} className="text-text-3" />
                    ) : (
                      <ChevronRight size={14} className="text-text-3" />
                    )}
                  </div>
                ),
              }}
              depth={depth}
              prefixIcon={
                <FileTypeIcon
                  fileName={group.fileName}
                  size="small"
                  className="flex-shrink-0"
                />
              }
              onClick={() => toggleFileGroup(group.filePath)}
            >
              <div className="flex items-center gap-1.5">
                {group.errorCount > 0 && (
                  <CountBadge count={group.errorCount} variant="error" />
                )}
                {group.warningCount > 0 && (
                  <CountBadge count={group.warningCount} variant="warning" />
                )}
              </div>
            </TreeRowBase>
          );
        }

        if (node.nodeType === "diagnostic" && node.diagnostic) {
          const diagnostic = node.diagnostic;
          const isSelected = selectedDiagnosticId === diagnostic.id;
          const locationSuffix = formatDiagnosticLocationSuffix(diagnostic);
          return (
            <div
              className={`tree-row-base group/item relative flex h-7 shrink-0 cursor-pointer items-center gap-1.5 pr-3 transition-colors ${isSelected ? SURFACE_TOKENS.selected : `${SURFACE_TOKENS.hover} active:bg-fill-2`}`}
              style={{
                paddingLeft: `${PROBLEMS_DIAGNOSTIC_ROW_PADDING_LEFT_PX}px`,
              }}
              onClick={() => {
                setSelectedDiagnosticId(diagnostic.id);
                onDiagnosticClick?.(diagnostic);
              }}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setSelectedDiagnosticId(diagnostic.id);
                  onDiagnosticClick?.(diagnostic);
                }
              }}
            >
              {indentGuidesEnabled &&
                depth > 0 &&
                Array.from({ length: depth }, (_, level) => (
                  <span
                    key={level}
                    className={TREE_INDENT_GUIDE_CLASS}
                    style={{
                      left: `${TREE_GUIDE_OFFSET_BASE + level * TREE_INDENT_PX}px`,
                    }}
                  />
                ))}
              <div className="relative z-[1] flex min-w-0 flex-1 items-center gap-1.5">
                <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                  {getSeverityIcon(diagnostic.severity)}
                </span>
                <span
                  className="min-w-0 flex-1 truncate text-[13px] text-text-1"
                  title={diagnostic.message}
                >
                  {diagnostic.message}
                </span>
                <span
                  className="shrink-0 whitespace-nowrap text-[11px] text-text-3"
                  title={locationSuffix}
                >
                  {locationSuffix}
                </span>
              </div>
            </div>
          );
        }

        return null;
      },
      [
        toggleFileGroup,
        onDiagnosticClick,
        selectedDiagnosticId,
        indentGuidesEnabled,
      ]
    );

    if (diagnostics.length === 0 && !isScanning) {
      return <HealthStatusDisplay className={className} />;
    }

    return (
      <div
        className={`flex h-full w-full flex-col overflow-hidden bg-workstation-bg ${className}`}
      >
        <div className="min-h-0 flex-1 overflow-hidden">
          {diagnostics.length > 0 ? (
            <VirtualizedStickyTree<ProblemsNode>
              flattenedNodes={flattenedNodes}
              rowHeight={FILE_HEADER_ROW_HEIGHT}
              renderItem={renderItem}
            />
          ) : (
            <Placeholder
              variant="loading"
              placement="sidebar"
              title={t("common:status.scanning")}
              fillParentHeight
            />
          )}
        </div>
      </div>
    );
  }
);

ProblemsContent.displayName = "ProblemsContent";

export default ProblemsContent;
