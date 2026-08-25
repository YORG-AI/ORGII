/**
 * Tree Row Base Component
 *
 * Shared base component for tree row rendering.
 * Handles: indentation, chevron/icon, name, selection styling.
 *
 * Used by source control, search results, and design tree lists.
 *
 * PERFORMANCE (Jan 2026):
 * - Uses forwardRef to allow parent components to manipulate DOM directly
 * - Supports .is-dragging CSS class for drag visual feedback without re-renders
 */
import { useAtomValue } from "jotai";
import { ChevronDown, ChevronRight, CornerDownRight } from "lucide-react";
import React, { forwardRef, useCallback } from "react";

import FileTypeIcon from "@src/components/FileTypeIcon";
import { SURFACE_TOKENS } from "@src/config/surfaceTokens";
import { useImmediateCursorReset } from "@src/hooks/ui/useImmediateCursorReset";
import { editorShowTreeIndentGuidesAtom } from "@src/store/ui/editorSettingsAtom";

import {
  CHEVRON_SIZE,
  TREE_GUIDE_OFFSET_BASE,
  TREE_INDENT_GUIDE_CLASS,
  TREE_INDENT_PX,
  TREE_PADDING_RIGHT,
  TREE_PADDING_X,
  TREE_ROW_HOVER_BG_CLASS,
  TREE_ROW_INSET_CLASS,
  TREE_ROW_INSET_X,
  TREE_ROW_ROUNDED_CLASS,
} from "./config";
import type { TreeRowBaseProps } from "./types";

export const TreeRowBase = React.memo(
  forwardRef<HTMLDivElement, TreeRowBaseProps>(
    (
      {
        node,
        depth,
        isSelected = false,
        isMultiSelected = false,
        onClick,
        onContextMenu,
        className = "",
        prefixIcon,
        children,
        dataPath,
        draggable = false,
        onDragStart,
        onDragEnd,
        onMouseDown,
        onMouseEnter,
        onMouseLeave,
        onPointerDown,
        showIndentGuides,
        showPathHint = false,
        showNativeTitle = true,
        rounded = true,
        inset = true,
      },
      ref
    ) => {
      const settingValue = useAtomValue(editorShowTreeIndentGuidesAtom);
      const indentGuidesEnabled = showIndentGuides ?? settingValue;

      const isDirectory = node.type === "directory";
      const isExpanded = node.expanded ?? false;
      const isHighlighted = isSelected || isMultiSelected;
      const isSymlink = node.isSymlink ?? false;
      const isIgnored = node.isIgnored ?? false;
      const isClickable = Boolean(onClick);
      const { cursorReset, markClicked, resetCursor } = useImmediateCursorReset(
        isHighlighted,
        isClickable
      );

      const handleRowClick = useCallback(
        (event: React.MouseEvent<HTMLDivElement>) => {
          markClicked();
          onClick?.(event);
        },
        [markClicked, onClick]
      );

      const handleMouseLeave = useCallback(
        (event: React.MouseEvent<HTMLDivElement>) => {
          resetCursor();
          onMouseLeave?.(event);
        },
        [onMouseLeave, resetCursor]
      );

      // Keep content aligned whether the row owns its outer inset or the host
      // surface supplies that spacing (for example, a padded dropdown panel).
      const rowInsetX = inset ? TREE_ROW_INSET_X : 0;
      const paddingLeft = depth * TREE_INDENT_PX + TREE_PADDING_X - rowInsetX;

      // Determine text color based on ignored state and selection
      const getTextColorClass = () => {
        if (isIgnored) {
          return "text-text-3";
        }
        if (isSelected) {
          return "text-text-1";
        }
        return "text-text-2";
      };

      return (
        <div
          ref={ref}
          data-tree-path={dataPath}
          className={`tree-row-base group/item relative ${inset ? TREE_ROW_INSET_CLASS : ""} flex h-7 min-w-0 shrink-0 ${
            isClickable && !cursorReset && !isHighlighted
              ? "cursor-pointer"
              : "cursor-default"
          } items-center gap-1.5 overflow-hidden transition-colors ${rounded ? TREE_ROW_ROUNDED_CLASS : ""} ${
            isHighlighted
              ? `${SURFACE_TOKENS.selected} ${SURFACE_TOKENS.selectedHover}`
              : TREE_ROW_HOVER_BG_CLASS
          } ${className}`}
          style={{
            paddingLeft: `${paddingLeft}px`,
            paddingRight: `${TREE_PADDING_RIGHT - rowInsetX}px`,
          }}
          onClick={isClickable ? handleRowClick : undefined}
          onContextMenu={onContextMenu}
          onMouseEnter={onMouseEnter}
          onMouseLeave={handleMouseLeave}
          draggable={draggable}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onMouseDown={onMouseDown}
          onPointerDown={onPointerDown}
        >
          {/* VS Code-style vertical indent guide lines */}
          {indentGuidesEnabled &&
            depth > 0 &&
            Array.from({ length: depth }, (_, level) => (
              <span
                key={level}
                className={TREE_INDENT_GUIDE_CLASS}
                style={{
                  left: `${TREE_GUIDE_OFFSET_BASE - rowInsetX + level * TREE_INDENT_PX}px`,
                }}
              />
            ))}
          {/* Icon slot — chevron for directories, custom icon if provided,
              file-type icon for plain files. If `icon` is explicitly set on
              the node (including to `null`/`false`), that signal is honored
              verbatim — i.e. passing `icon: null` renders no icon at all,
              matching the file-tree convention where rows without a chevron
              and without a real icon show nothing in the leading slot. */}
          {"icon" in node ? (
            node.icon ? (
              <span className={`flex-shrink-0 ${getTextColorClass()}`}>
                {node.icon}
              </span>
            ) : null
          ) : isDirectory ? (
            <div className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center">
              {isExpanded ? (
                <ChevronDown size={CHEVRON_SIZE} className="text-text-3" />
              ) : (
                <ChevronRight size={CHEVRON_SIZE} className="text-text-3" />
              )}
            </div>
          ) : (
            <FileTypeIcon
              fileName={node.name}
              size="small"
              className="flex-shrink-0"
            />
          )}

          {/* Prefix icon (e.g. file type icon for Problems panel) */}
          {prefixIcon && (
            <span className={`flex-shrink-0 ${getTextColorClass()}`}>
              {prefixIcon}
            </span>
          )}

          {/* Name - with path hint for flat list views (flex + per-segment truncate for ellipsis) */}
          <div
            className={`flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-[13px] ${
              isSelected ? "font-medium" : ""
            } ${getTextColorClass()}`}
            title={
              showNativeTitle
                ? isSymlink
                  ? `${node.name} (symlink)`
                  : node.path || node.name
                : undefined
            }
          >
            {showPathHint && !isDirectory && node.path.includes("/") ? (
              <>
                <span className="min-w-0 max-w-[min(55%,14rem)] shrink truncate">
                  {node.name}
                </span>
                <span className="min-w-0 flex-1 truncate text-[11px] text-text-3">
                  {node.path.substring(0, node.path.lastIndexOf("/"))}
                </span>
              </>
            ) : (
              <span className="min-w-0 flex-1 truncate">{node.name}</span>
            )}
          </div>

          {/* Additional content (action buttons, status badge, etc.) */}
          {children}

          {/* Symlink indicator — pinned to right end */}
          {isSymlink && (
            <CornerDownRight
              size={12}
              className="flex-shrink-0 text-text-3"
              aria-label="symlink"
            />
          )}
        </div>
      );
    }
  )
);

TreeRowBase.displayName = "TreeRowBase";

export default TreeRowBase;
