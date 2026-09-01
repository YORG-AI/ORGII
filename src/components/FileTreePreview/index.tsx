/**
 * FileTreePreview Component
 *
 * A reusable component that displays a file path as a hierarchical tree structure.
 * Shows the directory hierarchy with proper icons and highlights the target file/folder.
 *
 * Features:
 * - Converts absolute paths to repo-relative paths
 * - Shows folder/file type icons
 * - Highlights the target file/folder
 * - Customizable width and styling
 *
 * @example
 * <FileTreePreview
 *   path="/Users/dev/project/src/components/Button.tsx"
 *   repoPath="/Users/dev/project"
 *   itemType="file"
 * />
 */
import React, { memo, useMemo } from "react";

import FolderIcon from "@src/assets/fileTypeIcons/folder-base.svg";
import FileTypeIcon from "@src/components/FileTypeIcon";

import { STYLE_CONFIG } from "./config";
import { buildFileTree, getRepoRelativePath } from "./pathTree";
import { FileTreePreviewProps, TreeNode } from "./types";

// ============================================
// Component
// ============================================

const FileTreePreview: React.FC<FileTreePreviewProps> = memo(
  ({ path, itemType = "file", repoPath, width, className = "" }) => {
    // Convert to repo-relative path
    const relativePath = useMemo(
      () => getRepoRelativePath(path, repoPath),
      [path, repoPath]
    );

    // Build tree structure
    const tree = useMemo(() => buildFileTree(relativePath), [relativePath]);

    // Render tree recursively
    const renderTree = (
      nodes: TreeNode[],
      depth: number = 0
    ): React.ReactNode => {
      return nodes.map((node, nodeIndex) => (
        <div key={`${node.name}-${depth}-${nodeIndex}`}>
          <div
            className={`flex items-center gap-1.5 py-0.5 ${
              node.isHighlighted ? "text-primary-6" : "text-text-2"
            }`}
            style={{ paddingLeft: depth * STYLE_CONFIG.indentSize }}
          >
            {node.isFile && itemType !== "folder" ? (
              <FileTypeIcon
                fileName={node.name}
                size="small"
                className="shrink-0"
              />
            ) : (
              <FolderIcon
                width={STYLE_CONFIG.iconSize}
                height={STYLE_CONFIG.iconSize}
                className="shrink-0"
              />
            )}
            <span
              className={`truncate text-[11px] ${
                node.isHighlighted ? "font-medium text-primary-6" : ""
              }`}
            >
              {node.name}
            </span>
          </div>
          {node.children.length > 0 && renderTree(node.children, depth + 1)}
        </div>
      ));
    };

    return (
      <div
        className={`overflow-hidden rounded-[8px] border border-solid border-border-2 bg-bg-2 shadow-md ${className}`}
        style={{ width: width || STYLE_CONFIG.defaultWidth }}
      >
        <div className="px-3 py-2">{renderTree(tree)}</div>
      </div>
    );
  }
);

FileTreePreview.displayName = "FileTreePreview";

export default FileTreePreview;
