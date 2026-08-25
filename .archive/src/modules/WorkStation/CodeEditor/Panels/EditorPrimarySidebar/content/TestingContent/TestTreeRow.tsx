/**
 * TestTreeRow Component
 *
 * Individual test row for the virtualized tree.
 * Uses TreeRowBase for consistent styling with other tree views.
 */
import {
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Circle,
  Loader,
  Play,
  XCircle,
} from "lucide-react";
import React, { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import FileTypeIcon from "@src/components/FileTypeIcon";
import { TreeRowBase, type TreeRowNode } from "@src/components/TreeRow";
import { HEADER_BUTTON } from "@src/modules/WorkStation/shared/tokens";
import type { TestStatus } from "@src/types/testing/types";

import type { TestTreeRowProps } from "./types";

// ============================================
// Status Icon Component
// ============================================

const StatusIcon: React.FC<{ status?: TestStatus }> = ({ status }) => {
  const size = 14;

  switch (status) {
    case "passed":
      return <CheckCircle size={size} className="text-success-6" />;
    case "failed":
    case "errored":
      return <XCircle size={size} className="text-danger-6" />;
    case "running":
      return <Loader size={size} className="animate-spin text-primary-6" />;
    case "skipped":
      return <Circle size={size} className="text-text-4" />;
    default:
      return <Circle size={size} className="text-text-4" />;
  }
};

// ============================================
// Main Component
// ============================================

export const TestTreeRow: React.FC<TestTreeRowProps> = memo(
  ({ node, depth, onRunTest, onToggle, onFileClick }) => {
    const { t } = useTranslation();
    const { testItem } = node;
    const isFile = testItem.itemType === "file";
    const hasChildren = node.isFolder;

    // Map to TreeRowNode format
    const treeRowNode: TreeRowNode = useMemo(() => {
      // Determine icon based on item type
      let icon: React.ReactNode;
      if (isFile) {
        // Use file-type-specific icon for files
        icon = <FileTypeIcon fileName={node.name} size="small" />;
      } else if (hasChildren) {
        // Use chevron for all folders/suites with children
        icon = node.expanded ? (
          <ChevronDown size={14} className="text-text-3" />
        ) : (
          <ChevronRight size={14} className="text-text-3" />
        );
      } else {
        // Individual tests show status icon
        icon = <StatusIcon status={node.status} />;
      }

      return {
        id: node.path,
        name: node.name,
        path: testItem.path,
        type: hasChildren ? "directory" : "file",
        expanded: node.expanded,
        icon: (
          <div className="flex h-4 w-4 items-center justify-center">{icon}</div>
        ),
      };
    }, [node, isFile, hasChildren, testItem.path]);

    const handleClick = useCallback(() => {
      if (isFile && onFileClick) {
        onFileClick(testItem.path);
      } else if (hasChildren) {
        onToggle(node.path);
      }
    }, [isFile, hasChildren, node.path, testItem.path, onFileClick, onToggle]);

    const handleRun = useCallback(
      (event: React.MouseEvent) => {
        event.stopPropagation();
        onRunTest(testItem.id);
      },
      [testItem.id, onRunTest]
    );

    // Determine text color class based on test status
    const getStatusClassName = () => {
      if (node.status === "failed" || node.status === "errored") {
        return "[&_.min-w-0]:text-danger-6";
      }
      if (node.status === "passed") {
        return "[&_.min-w-0]:text-success-6";
      }
      return "";
    };

    return (
      <TreeRowBase
        node={treeRowNode}
        depth={depth}
        onClick={handleClick}
        className={getStatusClassName()}
      >
        {/* Duration */}
        {node.duration !== undefined && (
          <span className="shrink-0 text-[10px] text-text-4">
            {node.duration}ms
          </span>
        )}

        {/* Run button (on hover, no space when hidden) */}
        <button
          onClick={handleRun}
          className={`${HEADER_BUTTON.success} hidden shrink-0 group-focus-within/item:flex group-hover/item:flex`}
          title={t("tooltips.runTest")}
        >
          <Play size={10} />
        </button>
      </TreeRowBase>
    );
  }
);

TestTreeRow.displayName = "TestTreeRow";

export default TestTreeRow;
