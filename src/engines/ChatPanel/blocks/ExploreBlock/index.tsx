/**
 * Explore Block - Transparent variant for directory listing
 *
 * Displays directory contents with tree view
 * Uses file type icons like context menu
 */
import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import FileTypeIcon from "@src/components/FileTypeIcon";
import { getToolIcon } from "@src/config/toolIcons";
import ChatCodeBlock from "@src/engines/ChatPanel/blocks/CodeBlock";
import type { ToolUsageMetadata } from "@src/engines/SessionCore/core/types";

import ToolUsageBadge from "../ToolCallBlock/ToolUsageBadge";
import {
  ComposerStackListRow,
  EVENT_BLOCK_TRANSPARENT_EXPANDED_SHELL_CLASSES,
  EventBlockExpandableStackList,
  EventBlockHeader,
  EventBlockHeaderIcon,
  EventBlockHeaderSubtitle,
  EventBlockHeaderTitle,
  getEventBlockContainerClasses,
} from "../primitives";
import { useBlockHeader } from "../useBlockLocate";

const DEFAULT_VISIBLE_ITEMS = 5;
const ITEM_HEIGHT = 24;
const CHAT_CODE_FONT_SIZE = "var(--chat-code-font-size, 13px)";

function isDirectoryNotFoundExecutionFailure(message: string): boolean {
  return /Execution failed:\s*Directory not found/i.test(message);
}

interface TreeNode {
  absPath?: string;
  name?: string;
  childrenDirs?: TreeNode[];
  childrenFiles?: Array<{ name?: string }>;
}

interface DirEntryItem {
  kind: "dir" | "file";
  name: string;
}

export interface ExploreBlockProps {
  dirPath: string;
  dirs?: string[];
  files?: string[];
  treeRoot?: TreeNode | null;
  rawOutput?: unknown;
  isLoading?: boolean;
  isFailed?: boolean;
  defaultCollapsed?: boolean;
  eventId?: string;
  visibleItems?: number;
  bareMode?: boolean;
  /**
   * Hide the leading file-type icon on each row. Used when entries are
   * not real filesystem items (e.g. `query_lsp` diagnostic lines that are
   * routed through this block via `CbExplore` but carry no file identity).
   */
  hideEntryIcons?: boolean;
  /**
   * Pre-translated header title for the current state.
   * Adapter resolves via `useLifecycleLabels("list_dir", action)` and
   * picks running / done / failed. Blocks render this verbatim.
   */
  title: string;
  /**
   * Canonical tool name (e.g. `"list_dir"`, `"manage_workspace"`,
   * `"query_lsp"`) used to resolve the header icon from the Rust registry.
   * Falls back to `"list_dir"` when absent.
   */
  toolName?: string;
  /** Action-level hint for icon selection (e.g. `"ls"` vs `"tree"`). */
  action?: string;
  toolUsage?: ToolUsageMetadata;
}

const TreeConnector: React.FC<{ isLast: boolean }> = ({ isLast }) => (
  <span
    className="shrink-0 font-mono"
    style={{
      whiteSpace: "pre",
      fontSize: "16px",
      color: "var(--color-text-4)",
    }}
  >
    {isLast ? "└─ " : "├─ "}
  </span>
);

/** Flat directory listing row — composer stack row (same as file-in-review list). */
const ExploreFlatEntryRow: React.FC<{
  item: DirEntryItem;
  hideIcon?: boolean;
}> = React.memo(({ item, hideIcon = false }) => {
  if (isDirectoryNotFoundExecutionFailure(item.name)) {
    return (
      <ComposerStackListRow
        title={item.name}
        leading={getToolIcon("list_dir", {
          size: 14,
          className: "shrink-0 text-text-3",
        })}
        primary={item.name}
      />
    );
  }

  const isDir = item.kind === "dir";
  const iconName = isDir
    ? item.name.endsWith("/")
      ? item.name
      : `${item.name}/`
    : item.name;
  const label = isDir ? `${item.name.replace(/\/$/, "")}/` : item.name;

  return (
    <ComposerStackListRow
      title={label}
      leading={
        hideIcon ? null : <FileTypeIcon fileName={iconName} size="small" />
      }
      primary={label}
    />
  );
});
ExploreFlatEntryRow.displayName = "ExploreFlatEntryRow";

const ExploreBlock: React.FC<ExploreBlockProps> = React.memo(
  ({
    dirPath,
    dirs = [],
    files = [],
    treeRoot,
    rawOutput,
    isLoading = false,
    isFailed = false,
    defaultCollapsed = true,
    eventId,
    visibleItems = DEFAULT_VISIBLE_ITEMS,
    bareMode = false,
    title,
    toolName = "list_dir",
    action,
    hideEntryIcons = false,
    toolUsage,
  }) => {
    void isFailed;
    const { t } = useTranslation("sessions");
    const toolIcon = useMemo(
      () =>
        getToolIcon(toolName, {
          size: 14,
          className: "text-text-2",
          action,
        }),
      [toolName, action]
    );
    const {
      isCollapsed,
      isHeaderHovered,
      handleHeaderClick,
      handleHeaderMouseEnter,
      handleHeaderMouseLeave,
      handleLocate,
    } = useBlockHeader({
      defaultCollapsed,
      eventId,
      collapseAllValue: true,
      preserveDefaultOnExpand: true,
    });

    const dirName = dirPath.split("/").pop() || dirPath;
    const hasMeaningfulDirPath = Boolean(dirPath) && dirPath !== ".";
    const totalItems = dirs.length + files.length;

    const hasContent =
      totalItems > 0 ||
      Boolean(
        rawOutput &&
        (typeof rawOutput === "string" ? rawOutput.length > 0 : true)
      );

    const flatItems = useMemo<DirEntryItem[]>(() => {
      const result: DirEntryItem[] = [];
      for (const dir of dirs) result.push({ kind: "dir", name: dir });
      for (const file of files) result.push({ kind: "file", name: file });
      return result;
    }, [dirs, files]);

    const renderFlatItem = useCallback(
      (
        item: DirEntryItem,
        _idx: number,
        _displayed: readonly DirEntryItem[]
      ) => <ExploreFlatEntryRow item={item} hideIcon={hideEntryIcons} />,
      [hideEntryIcons]
    );

    const getEntryKey = useCallback(
      (item: DirEntryItem, idx: number) => `${item.kind}-${idx}`,
      []
    );

    const renderTreeNode = (
      node: TreeNode,
      depth: number = 0,
      isLast: boolean = true,
      parentPrefix: string = ""
    ): React.ReactNode => {
      const name = node.name || node.absPath?.split("/").pop() || "";
      const currentPrefix = parentPrefix + (isLast ? "└─ " : "├─ ");
      const childPrefix = parentPrefix + (isLast ? "   " : "│  ");

      return (
        <div key={node.absPath || name}>
          <div
            className="flex min-w-0 items-center gap-2"
            style={{ height: `${ITEM_HEIGHT}px` }}
          >
            <span
              className="shrink-0 font-mono"
              style={{
                whiteSpace: "pre",
                fontSize: "16px",
                color: "var(--color-text-3)",
              }}
            >
              {currentPrefix}
            </span>
            {!hideEntryIcons && (
              <FileTypeIcon fileName={`${name}/`} size="tiny" />
            )}
            <span className="min-w-0 flex-1 truncate text-text-1" title={name}>
              {name}/
            </span>
          </div>

          {node.childrenDirs?.map((child, idx) =>
            renderTreeNode(
              child,
              depth + 1,
              idx === (node.childrenDirs?.length || 0) - 1 &&
                (!node.childrenFiles || node.childrenFiles.length === 0),
              childPrefix
            )
          )}

          {node.childrenFiles?.map((file, idx) => (
            <div
              key={file.name}
              className="flex min-w-0 items-center gap-2"
              style={{ height: `${ITEM_HEIGHT}px` }}
            >
              <span
                className="shrink-0 font-mono"
                style={{
                  whiteSpace: "pre",
                  fontSize: "16px",
                  color: "var(--color-text-3)",
                }}
              >
                {childPrefix +
                  (idx === (node.childrenFiles?.length || 0) - 1
                    ? "└─ "
                    : "├─ ")}
              </span>
              {!hideEntryIcons && (
                <FileTypeIcon fileName={file.name || ""} size="tiny" />
              )}
              <span
                className="min-w-0 flex-1 truncate text-text-2"
                title={file.name || undefined}
              >
                {file.name}
              </span>
            </div>
          ))}
        </div>
      );
    };

    const treeContentJSX = treeRoot ? (
      <div
        className="explore-block__items-container px-4 py-2"
        style={{
          fontSize: CHAT_CODE_FONT_SIZE,
          lineHeight: `${ITEM_HEIGHT}px`,
          ...(bareMode ? {} : { maxHeight: "250px", overflow: "auto" }),
        }}
      >
        {treeRoot.childrenDirs?.map((child, idx) =>
          renderTreeNode(
            child,
            0,
            idx === (treeRoot.childrenDirs?.length || 0) - 1 &&
              (!treeRoot.childrenFiles || treeRoot.childrenFiles.length === 0),
            ""
          )
        )}
        {treeRoot.childrenFiles?.map((file, idx) => (
          <div
            key={file.name}
            className="flex min-w-0 items-center gap-2"
            style={{ height: `${ITEM_HEIGHT}px` }}
          >
            <TreeConnector
              isLast={idx === (treeRoot.childrenFiles?.length || 0) - 1}
            />
            {!hideEntryIcons && (
              <FileTypeIcon fileName={file.name || ""} size="tiny" />
            )}
            <span
              className="min-w-0 flex-1 truncate text-text-2"
              title={file.name || undefined}
            >
              {file.name}
            </span>
          </div>
        ))}
      </div>
    ) : null;

    const rawFallbackJSX =
      totalItems === 0 && rawOutput ? (
        <ChatCodeBlock
          code={(() => {
            const displayStr =
              typeof rawOutput === "string"
                ? rawOutput
                : JSON.stringify(rawOutput, null, 2);
            return displayStr.length > 2000
              ? displayStr.slice(0, 2000) + "\n... (truncated)"
              : displayStr;
          })()}
          language="json"
          title={t("tools.directoryTree")}
          maxHeight={200}
          showLineNumbers={false}
          defaultCollapsed={false}
          hideHeader={true}
        />
      ) : null;

    const flatContentJSX = !treeRoot ? (
      flatItems.length > 0 ? (
        <EventBlockExpandableStackList
          layout="body"
          sectionWithAnimation
          items={flatItems}
          renderItem={renderFlatItem}
          getKey={getEntryKey}
          visibleCount={visibleItems}
        />
      ) : (
        <div className="explore-block__items-container px-4 py-2">
          {rawFallbackJSX}
        </div>
      )
    ) : null;

    if (bareMode) {
      return treeContentJSX || flatContentJSX;
    }

    return (
      <div className={`group/explore ${getEventBlockContainerClasses(false)}`}>
        <EventBlockHeader
          isCollapsed={isCollapsed}
          withHover={false}
          onClick={hasContent ? handleHeaderClick : undefined}
          onNavigate={handleLocate}
          onMouseEnter={handleHeaderMouseEnter}
          onMouseLeave={handleHeaderMouseLeave}
          className={eventId ? "cursor-pointer" : undefined}
          rightContent={
            toolUsage ? <ToolUsageBadge usage={toolUsage} /> : undefined
          }
        >
          <EventBlockHeaderIcon
            icon={toolIcon}
            isCollapsed={isCollapsed}
            isHeaderHovered={isHeaderHovered}
            onToggle={hasContent ? handleHeaderClick : undefined}
            hasContent={hasContent}
            revealChevronOnIconHoverOnly={Boolean(eventId)}
            isLoading={isLoading}
          />
          <EventBlockHeaderTitle isLoading={isLoading}>
            {title}
          </EventBlockHeaderTitle>
          {hasMeaningfulDirPath && (
            <EventBlockHeaderSubtitle isLoading={isLoading} title={dirPath}>
              {dirName}/
            </EventBlockHeaderSubtitle>
          )}
        </EventBlockHeader>

        {!isCollapsed && hasContent && !isLoading && (
          <div className="explore-block__content animate-fade-in overflow-hidden">
            <div className={EVENT_BLOCK_TRANSPARENT_EXPANDED_SHELL_CLASSES}>
              {treeContentJSX || flatContentJSX}
            </div>
          </div>
        )}
      </div>
    );
  }
);

ExploreBlock.displayName = "ExploreBlock";

export default ExploreBlock;
