/**
 * InputEditor Component
 *
 * ComposerInput-based input area with drag-drop support and keyboard handling.
 * Uses ComposerInput for proper cursor/selection handling around file pills.
 */
import { clsx } from "clsx";
import { useAtomValue } from "jotai";
import React, { memo, useCallback, useRef } from "react";

import ComposerInput, { ComposerInputRef } from "@src/components/ComposerInput";
import {
  INPUT_AREA_EDITOR_CLASS,
  INPUT_AREA_EDITOR_HEIGHT,
} from "@src/config/inputAreaTokens";
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
  /** Inline ghost hint after the last content node (see ComposerInput) */
  trailingHint?: string | null;
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
  /** Focus the contenteditable host after mount. */
  autoFocus?: boolean;
  /**
   * Non-document context rendered on the editor's first line before the
   * contenteditable surface. This intentionally stays outside the serialized
   * composer value (for example, a Canvas element selection that is submitted
   * through a dedicated override payload).
   */
  leadingContent?: React.ReactNode;
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
    trailingHint = null,
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
    autoFocus = false,
    leadingContent,
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
          compact
            ? "relative flex h-full min-h-0 w-full min-w-0 items-center"
            : "relative flex w-full min-w-0 items-start"
        }
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onFocus={onFocus}
        onBlur={onBlur}
      >
        {leadingContent && (
          <div
            data-composer-leading-content
            className={`flex shrink-0 items-center pl-3 text-sm leading-5 ${compact ? "h-full" : "pt-0.5"}`}
          >
            {leadingContent}
          </div>
        )}
        <ComposerInput
          ref={composerInputRef}
          placeholder={placeholder}
          trailingHint={trailingHint}
          onContentChange={(text) => onContentChange?.(text)}
          onAtMention={onAtMention}
          onAtMentionClose={onAtMentionClose}
          onSubmit={onSubmit}
          requireCmdEnter={!sendOnEnter}
          autoFocus={autoFocus}
          className={
            compact
              ? "chat-input-editor chat-input-compact h-full max-h-9 min-h-0 min-w-0 flex-1"
              : clsx(
                  INPUT_AREA_EDITOR_CLASS,
                  leadingContent &&
                    "chat-input-editor chat-input-editor-leading"
                )
          }
          minHeight={compact ? 0 : INPUT_AREA_EDITOR_HEIGHT.min}
          maxHeight={compact ? 36 : INPUT_AREA_EDITOR_HEIGHT.max}
          overflowY={compact ? "visible" : undefined}
          onKeyDownForDropdown={handleKeyDownForDropdown}
          onSlashCommand={onSlashCommand}
          onSlashCommandClose={onSlashCommandClose}
          onInputMouseDown={onInputMouseDown}
          onKeyDownForSlashDropdown={handleKeyDownForSlashDropdown}
          slashTriggerMode={slashTriggerMode}
          onImagePaste={onImagePaste}
        />
      </div>
    );
  }
);

InputEditor.displayName = "InputEditor";

export default InputEditor;
