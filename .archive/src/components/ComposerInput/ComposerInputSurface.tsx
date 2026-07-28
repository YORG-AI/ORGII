import React, { forwardRef, memo, useCallback } from "react";

import ComposerInput from "./index";
import type { ComposerInputProps, ComposerInputRef } from "./types";

export interface ComposerInputSurfaceProps extends ComposerInputProps {
  wrapperClassName?: string;
  onFocus?: () => void;
  onBlur?: () => void;
  onDragOver?: (event: React.DragEvent<HTMLDivElement>) => void;
  onDragLeave?: (event: React.DragEvent<HTMLDivElement>) => void;
  onDrop?: (event: React.DragEvent<HTMLDivElement>) => void;
  contextMenuVisible?: boolean;
  contextMenuKeyboardHandlerRef?: React.MutableRefObject<
    ((event: React.KeyboardEvent) => boolean) | null
  >;
  slashMenuVisible?: boolean;
  slashCommandKeyboardHandlerRef?: React.MutableRefObject<
    ((event: KeyboardEvent) => boolean) | null
  >;
}

const ComposerInputSurface = memo(
  forwardRef<ComposerInputRef, ComposerInputSurfaceProps>(
    function ComposerInputSurface(
      {
        wrapperClassName = "relative w-full min-w-0",
        onFocus,
        onBlur,
        onDragOver,
        onDragLeave,
        onDrop,
        contextMenuVisible = false,
        contextMenuKeyboardHandlerRef,
        slashMenuVisible = false,
        slashCommandKeyboardHandlerRef,
        onContentChange,
        ...composerProps
      },
      ref
    ) {
      const handleKeyDownForDropdown = useCallback(
        (event: KeyboardEvent): boolean => {
          if (!contextMenuVisible || !contextMenuKeyboardHandlerRef?.current) {
            return false;
          }
          const reactEvent = {
            key: event.key,
            code: event.code,
            altKey: event.altKey,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            shiftKey: event.shiftKey,
            repeat: event.repeat,
            preventDefault: () => event.preventDefault(),
            stopPropagation: () => event.stopPropagation(),
            nativeEvent: event,
          } as unknown as React.KeyboardEvent;
          return contextMenuKeyboardHandlerRef.current(reactEvent);
        },
        [contextMenuKeyboardHandlerRef, contextMenuVisible]
      );

      const handleKeyDownForSlashDropdown = useCallback(
        (event: KeyboardEvent): boolean => {
          if (!slashMenuVisible || !slashCommandKeyboardHandlerRef?.current) {
            return false;
          }
          return slashCommandKeyboardHandlerRef.current(event);
        },
        [slashCommandKeyboardHandlerRef, slashMenuVisible]
      );

      return (
        <div
          className={wrapperClassName}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          onFocus={onFocus}
          onBlur={onBlur}
        >
          <ComposerInput
            {...composerProps}
            ref={ref}
            onContentChange={onContentChange}
            onKeyDownForDropdown={handleKeyDownForDropdown}
            onKeyDownForSlashDropdown={handleKeyDownForSlashDropdown}
          />
        </div>
      );
    }
  )
);

ComposerInputSurface.displayName = "ComposerInputSurface";

export default ComposerInputSurface;
