/**
 * NewItemInput Component
 *
 * Inline input for creating new files/folders in the file tree (VS Code pattern).
 * Features:
 * - Auto-focus
 * - Enter to confirm, Escape to cancel
 * - Click outside to cancel (unlike rename which confirms)
 * - Dynamic file type icon based on typed extension
 */
import { ChevronDown } from "lucide-react";
import React, { useCallback, useEffect, useRef, useState } from "react";

import FileTypeIcon from "@src/components/FileTypeIcon";
import {
  CHEVRON_SIZE,
  TREE_INDENT_PX,
  TREE_PADDING_RIGHT,
  TREE_PADDING_X,
  TREE_ROW_INSET_CLASS,
  TREE_ROW_INSET_X,
  TREE_ROW_ROUNDED_CLASS,
} from "@src/components/TreeRow";
import { useMountedCleanup } from "@src/hooks/lifecycle/useMounted";

export interface NewItemInputProps {
  /** Parent directory depth for indentation */
  depth: number;
  /** Whether creating a folder (true) or file (false) */
  isFolder: boolean;
  /** Callback when creation is confirmed with a valid name */
  onConfirm: (name: string) => void;
  /** Callback when creation is cancelled */
  onCancel: () => void;
}

export function NewItemInput({
  depth,
  isFolder,
  onConfirm,
  onCancel,
}: NewItemInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const hasSubmittedRef = useRef(false);
  const isMountedRef = useRef(true);
  useMountedCleanup(isMountedRef);

  // Auto-focus on mount
  useEffect(() => {
    requestAnimationFrame(() => {
      if (isMountedRef.current && inputRef.current) {
        inputRef.current.focus();
      }
    });
  }, [isMountedRef]);

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      setValue(event.target.value);
    },
    []
  );

  const handleConfirm = useCallback(() => {
    if (hasSubmittedRef.current) return;
    hasSubmittedRef.current = true;

    const trimmedValue = value.trim();
    if (trimmedValue) {
      onConfirm(trimmedValue);
    } else {
      onCancel();
    }
  }, [value, onConfirm, onCancel]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      switch (event.key) {
        case "Enter":
          event.preventDefault();
          event.stopPropagation();
          handleConfirm();
          break;
        case "Escape":
          event.preventDefault();
          event.stopPropagation();
          if (!hasSubmittedRef.current) {
            hasSubmittedRef.current = true;
            onCancel();
          }
          break;
      }
    },
    [handleConfirm, onCancel]
  );

  // Handle blur (click outside) - cancel for new items
  const handleBlur = useCallback(() => {
    // Small delay to allow keydown handlers to run first
    setTimeout(() => {
      if (!hasSubmittedRef.current && isMountedRef.current) {
        const trimmedValue = value.trim();
        if (trimmedValue) {
          handleConfirm();
        } else {
          hasSubmittedRef.current = true;
          onCancel();
        }
      }
    }, 0);
  }, [value, handleConfirm, onCancel, isMountedRef]);

  const paddingLeft =
    depth * TREE_INDENT_PX + TREE_PADDING_X - TREE_ROW_INSET_X;

  return (
    <div
      className={`tree-row-base group/item ${TREE_ROW_INSET_CLASS} flex h-7 shrink-0 items-center gap-1.5 ${TREE_ROW_ROUNDED_CLASS} bg-primary-1`}
      style={{
        paddingLeft: `${paddingLeft}px`,
        paddingRight: `${TREE_PADDING_RIGHT - TREE_ROW_INSET_X}px`,
      }}
    >
      {isFolder ? (
        <div className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
          <ChevronDown size={CHEVRON_SIZE} className="text-text-3" />
        </div>
      ) : (
        <FileTypeIcon
          fileName={value || "untitled"}
          size="small"
          className="flex-shrink-0"
        />
      )}

      <div className="min-w-0 flex-1">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          placeholder={isFolder ? "folder name" : "file name"}
          className="h-[22px] w-full min-w-0 rounded border border-primary-6 bg-pane-input px-1 text-[13px] text-text-1 outline-none ring-1 ring-primary-6/30 placeholder:text-text-4"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
        />
      </div>
    </div>
  );
}

export default NewItemInput;
