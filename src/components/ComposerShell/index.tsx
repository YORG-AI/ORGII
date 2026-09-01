/**
 * ComposerShell
 *
 * Shared outer shell for all composer/input surfaces (chat panel, session
 * creator, edit mode).  Owns the border, border-radius, padding, background,
 * edge shadow, and focus-within ring without duplicating
 * token references.
 *
 * Variants
 * --------
 * • "default"  — session creator, standalone (bg-chat-input)
 * • "embedded" — chat panel embedded in conversation (bg-chat-input)
 * • "comment"  — compact avatar-adjacent comment input
 * • "edit"     — queued-message edit box (label strip + inner editor card)
 * • "historyEdit" — sent-message edit box (single layer, same token as normal input)
 */
import React, { forwardRef } from "react";

import { INPUT_AREA } from "@src/config/inputAreaTokens";

type ComposerShellVariant =
  | "default"
  | "embedded"
  | "comment"
  | "edit"
  | "historyEdit";

export interface ComposerShellProps {
  variant?: ComposerShellVariant;
  /** Extra className forwarded to the shell div */
  className?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
  /** Forwarded event handlers */
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
  onDragOver?: React.DragEventHandler<HTMLDivElement>;
  onDragLeave?: React.DragEventHandler<HTMLDivElement>;
  onDrop?: React.DragEventHandler<HTMLDivElement>;
  onDropCapture?: React.DragEventHandler<HTMLDivElement>;
  /** data-* / aria-* passthrough */
  [key: `data-${string}`]: unknown;
}

const VARIANT_CLASSES: Record<ComposerShellVariant, string> = {
  default: `composer-surface-shadow ${INPUT_AREA.borderRadiusClass} px-1.5 pt-2.5 pb-1.5 gap-2`,
  embedded: `composer-surface-shadow ${INPUT_AREA.borderRadiusClass} px-1.5 pt-2.5 pb-1.5 gap-2`,
  comment: `composer-surface-shadow ${INPUT_AREA.borderRadiusClass} px-1.5 py-1.5 gap-1.5`,
  // `edit` is the OUTER label strip — the inner editor card is rendered as
  // a separately-styled child (see `InputArea`). The strip itself is just
  // a padded container that hosts the label row + the inner card.
  edit: `${INPUT_AREA.borderRadiusEditClass} p-1.5 gap-1.5`,
  historyEdit: `${INPUT_AREA.borderRadiusClass} px-1.5 pt-2.5 pb-1.5 gap-2`,
};

const VARIANT_BG_CLASS: Record<ComposerShellVariant, string> = {
  default: INPUT_AREA.backgroundDefaultClass,
  embedded: INPUT_AREA.backgroundChatPanelClass,
  comment: INPUT_AREA.backgroundChatPanelClass,
  // The outer edit strip sits on `bg-fill-2` so it reads as a distinct card
  // that wraps the header row + inner editor card (`bg-fill-1`).
  edit: "bg-fill-2",
  historyEdit: INPUT_AREA.backgroundChatPanelClass,
};

// The `edit` variant outer strip has a static border (no hover/focus ring —
// those belong to the INNER editor card). This makes the whole edit surface
// read as a single card rather than two unrelated floating elements.
const VARIANT_INTERACTION_CLASSES: Record<ComposerShellVariant, string> = {
  default: INPUT_AREA.shellInteractionClasses,
  embedded: INPUT_AREA.shellInteractionClasses,
  comment: INPUT_AREA.shellInteractionClasses,
  edit: INPUT_AREA.borderClass,
  historyEdit: INPUT_AREA.shellEditInteractionClasses,
};

const ComposerShell = forwardRef<HTMLDivElement, ComposerShellProps>(
  (
    {
      variant = "default",
      className = "",
      style,
      children,
      onKeyDown,
      onDragOver,
      onDragLeave,
      onDrop,
      onDropCapture,
      ...dataProps
    },
    ref
  ) => {
    return (
      <div
        ref={ref}
        className={`relative flex w-full ${variant === "comment" ? "flex-row items-end" : "flex-col"} transition-[padding] duration-200 ease-out ${VARIANT_INTERACTION_CLASSES[variant]} ${VARIANT_CLASSES[variant]} ${VARIANT_BG_CLASS[variant]} ${className}`}
        style={style}
        onKeyDown={onKeyDown}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onDropCapture={onDropCapture}
        {...dataProps}
      >
        {children}
      </div>
    );
  }
);

ComposerShell.displayName = "ComposerShell";

export default ComposerShell;
