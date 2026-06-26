/**
 * InputEditor Component
 *
 * ComposerInput-based input area with drag-drop support and keyboard handling.
 * Uses ComposerInput for proper cursor/selection handling around file pills.
 */
import { useAtomValue } from "jotai";
import React, { memo, useCallback, useRef } from "react";

import ComposerInput, { ComposerInputRef } from "@src/components/ComposerInput";
import { chatAppearanceAtom } from "@src/store/config/configAtom";

// ============================================
// Type Definitions
// ============================================

export interface InputEditorProps {
  /** Ref to the Composer input */
  composerInputRef: React.Ref<ComposerInputRef>;
  /** Whether context menu is visible */
  showContextMenu: boolean;
  /** Keyboard handler ref from context menu */
  contextMenuKeyboardHandlerRef: React.MutableRefObject<
    ((e: React.KeyboardEvent) => boolean) | null
  >;
  /** Content change handler */
  onContentChange?: (text: string) => void;
  /** @ mention handler */
  onAtMention?: (query: string, position: { x: number; y: number }) => void;
  /** @ mention close handler */
  onAtMentionClose?: () => void;
  /** Submit handler */
  onSubmit?: (text: string) => void;
  /** Focus handler */
  onFocus?: () => void;
  /** Blur handler */
  onBlur?: () => void;
  /** Drag over handler */
  onDragOver?: (e: React.DragEvent<HTMLDivElement>) => void;
  /** Drag leave handler */
  onDragLeave?: (e: React.DragEvent<HTMLDivElement>) => void;
  /** Drop handler */
  onDrop?: (e: React.DragEvent<HTMLDivElement>) => void;
  /** Placeholder text */
  placeholder?: string;
  /** Callback when images are pasted from clipboard */
  onImagePaste?: (files: File[]) => void;
  /** Whether inline "/" slash command menu is visible */
  showSlashMenu?: boolean;
  /** Keyboard handler ref for the inline "/" slash command menu */
  slashCommandKeyboardHandlerRef?: React.MutableRefObject<
    ((e: KeyboardEvent) => boolean) | null
  >;
  /** Whether "+" button slash command menu is visible */
  showPlusSlashMenu?: boolean;
  /** Keyboard handler ref for the "+" button slash command menu */
  plusSlashCommandKeyboardHandlerRef?: React.MutableRefObject<
    ((e: KeyboardEvent) => boolean) | null
  >;
  /** Slash command handler */
  onSlashCommand?: (query: string) => void;
  /** Slash command close handler */
  onSlashCommandClose?: () => void;
  /** Called when the user clicks into the editable input surface. */
  onInputMouseDown?: () => void;
  /** Slash trigger behavior for this editor surface. */
  slashTriggerMode?: "command" | "context";
  /** Single-line height for compact composer row */
  compact?: boolean;
  /** Called synchronously before a newline is inserted. */
  onBeforeNewline?: () => void;
}

// ============================================
// Component
// ============================================

const InputEditor: React.FC<InputEditorProps> = memo(
  ({
    composerInputRef,
    showContextMenu,
    contextMenuKeyboardHandlerRef,
    onContentChange,
    onAtMention,
    onAtMentionClose,
    onSubmit,
    onFocus,
    onBlur,
    onDragOver,
    onDragLeave,
    onDrop,
    placeholder = "Type your message...",
    onImagePaste,
    showSlashMenu,
    slashCommandKeyboardHandlerRef,
    showPlusSlashMenu,
    plusSlashCommandKeyboardHandlerRef,
    onSlashCommand,
    onSlashCommandClose,
    onInputMouseDown,
    slashTriggerMode = "command",
    compact = false,
    onBeforeNewline,
  }) => {
    const wrapperRef = useRef<HTMLDivElement>(null);
    const { sendOnEnter } = useAtomValue(chatAppearanceAtom);

    // ============================================
    // Keyboard Handler for Dropdown
    // ============================================

    /**
     * Delegate keyboard events to the context menu when dropdown is visible
     */
    const handleKeyDownForDropdown = useCallback(
      (event: KeyboardEvent): boolean => {
        if (showContextMenu && contextMenuKeyboardHandlerRef.current) {
          // Create a React-like keyboard event for the handler
          const reactEvent = {
            key: event.key,
            code: event.code,
            preventDefault: () => event.preventDefault(),
            stopPropagation: () => event.stopPropagation(),
            nativeEvent: event,
          } as React.KeyboardEvent;

          return contextMenuKeyboardHandlerRef.current(reactEvent);
        }
        return false;
      },
      [showContextMenu, contextMenuKeyboardHandlerRef]
    );

    /**
     * Delegate keyboard events to whichever slash command dropdown is open.
     * The "+" menu takes priority; falls back to the inline "/" menu.
     */
    const handleKeyDownForSlashDropdown = useCallback(
      (event: KeyboardEvent): boolean => {
        if (showPlusSlashMenu && plusSlashCommandKeyboardHandlerRef?.current) {
          return plusSlashCommandKeyboardHandlerRef.current(event);
        }
        if (showSlashMenu && slashCommandKeyboardHandlerRef?.current) {
          return slashCommandKeyboardHandlerRef.current(event);
        }
        return false;
      },
      [
        showPlusSlashMenu,
        plusSlashCommandKeyboardHandlerRef,
        showSlashMenu,
        slashCommandKeyboardHandlerRef,
      ]
    );

    // ============================================
    // Render
    // ============================================

    return (
      <div
        ref={wrapperRef}
        className={
          compact ? "relative h-full min-h-0 w-full" : "relative w-full min-w-0"
        }
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onFocus={onFocus}
        onBlur={onBlur}
      >
        <ComposerInput
          ref={composerInputRef}
          placeholder={placeholder}
          onContentChange={(text) => onContentChange?.(text)}
          onAtMention={onAtMention}
          onAtMentionClose={onAtMentionClose}
          onSubmit={onSubmit}
          requireCmdEnter={!sendOnEnter}
          autoFocus={false}
          className={
            compact
              ? "chat-input-editor chat-input-compact h-full max-h-9 min-h-0"
              : "chat-input-editor max-h-[140px] min-h-[60px] overflow-y-auto"
          }
          minHeight={compact ? 0 : 60}
          maxHeight={compact ? 36 : 140}
          overflowY={compact ? "visible" : undefined}
          onKeyDownForDropdown={handleKeyDownForDropdown}
          onSlashCommand={onSlashCommand}
          onSlashCommandClose={onSlashCommandClose}
          onInputMouseDown={onInputMouseDown}
          onKeyDownForSlashDropdown={handleKeyDownForSlashDropdown}
          slashTriggerMode={slashTriggerMode}
          onImagePaste={onImagePaste}
          onBeforeNewline={onBeforeNewline}
        />
      </div>
    );
  }
);

InputEditor.displayName = "InputEditor";

export default InputEditor;
