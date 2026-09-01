/**
 * WorkStation InlineRenameInput Component
 *
 * Inline text input for renaming files/folders in the file tree.
 * Features:
 * - Auto-focus and select filename (without extension for files)
 * - F2 cycles selection: basename → full → extension → repeat
 * - Enter to confirm, Escape to cancel
 * - Click outside to confirm
 */
import React, { useCallback, useEffect, useRef, useState } from "react";

export interface InlineRenameInputProps {
  /** Current name of the file/folder */
  initialName: string;
  /** Whether this is a directory */
  isDirectory: boolean;
  /** Callback when rename is confirmed */
  onConfirm: (newName: string) => void;
  /** Callback when rename is cancelled */
  onCancel: () => void;
  /** Optional callback when value changes (for dynamic icon updates) */
  onValueChange?: (value: string) => void;
}

type SelectionMode = "basename" | "full" | "extension";

/**
 * Get the extension position in a filename.
 * Returns -1 if no extension or if it's a hidden file (starts with .)
 */
export function getExtensionIndex(filename: string): number {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot <= 0) return -1;
  return lastDot;
}

export function applySelection(
  input: HTMLInputElement,
  filename: string,
  mode: SelectionMode
): void {
  const extensionIndex = getExtensionIndex(filename);

  switch (mode) {
    case "basename":
      if (extensionIndex > 0) {
        input.setSelectionRange(0, extensionIndex);
      } else {
        input.setSelectionRange(0, filename.length);
      }
      break;
    case "full":
      input.setSelectionRange(0, filename.length);
      break;
    case "extension":
      if (extensionIndex > 0) {
        input.setSelectionRange(extensionIndex, filename.length);
      } else {
        input.setSelectionRange(0, filename.length);
      }
      break;
  }
}

export function getNextSelectionMode(
  current: SelectionMode,
  hasExtension: boolean
): SelectionMode {
  if (!hasExtension) return "full";

  switch (current) {
    case "basename":
      return "full";
    case "full":
      return "extension";
    case "extension":
      return "basename";
  }
}

export function InlineRenameInput({
  initialName,
  isDirectory,
  onConfirm,
  onCancel,
  onValueChange,
}: InlineRenameInputProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initialName);
  const [selectionMode, setSelectionMode] = useState<SelectionMode>("basename");
  const hasSubmittedRef = useRef(false);

  // Auto-focus and select on mount only
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;

    input.focus();

    // For directories, select all; for files, select basename
    if (isDirectory) {
      input.setSelectionRange(0, initialName.length);
    } else {
      applySelection(input, initialName, "basename");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rename identity is mount-owned; a different file remounts this editor, and reselection mid-edit would discard the user's range
  }, []);

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = event.target.value;
      setValue(newValue);
      onValueChange?.(newValue);
    },
    [onValueChange]
  );

  const handleConfirm = useCallback(() => {
    if (hasSubmittedRef.current) return;
    hasSubmittedRef.current = true;

    const trimmedValue = value.trim();
    if (trimmedValue && trimmedValue !== initialName) {
      onConfirm(trimmedValue);
    } else {
      onCancel();
    }
  }, [value, initialName, onConfirm, onCancel]);

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
          onCancel();
          break;
        case "F2":
          event.preventDefault();
          event.stopPropagation();
          if (!isDirectory) {
            const input = inputRef.current;
            if (!input) return;

            const hasExtension = getExtensionIndex(value) > 0;
            const nextMode = getNextSelectionMode(selectionMode, hasExtension);
            setSelectionMode(nextMode);
            applySelection(input, value, nextMode);
          }
          break;
      }
    },
    [handleConfirm, onCancel, isDirectory, value, selectionMode]
  );

  const handleBlur = useCallback(() => {
    // Small delay to allow other handlers to run first
    setTimeout(() => {
      handleConfirm();
    }, 0);
  }, [handleConfirm]);

  return (
    <input
      ref={inputRef}
      type="text"
      value={value}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      className="h-[22px] w-full min-w-0 rounded border border-primary-6 bg-pane-input px-1 text-[13px] text-text-1 ring-1 ring-primary-6/30 outline-none"
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
    />
  );
}

export default InlineRenameInput;
