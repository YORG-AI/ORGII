/**
 * Input Area Design Tokens
 *
 * Shared tokens for composer/input areas used by:
 * - ChatPanel InputArea
 * - SessionCreator EditorArea
 * - InputArea pinned mode
 *
 * Ensures consistent radius, padding, borders, and button sizes.
 *
 * Composer stack rows/shells above the input live in `composerStackTokens.ts`.
 */
import type { CSSProperties } from "react";

import { CHAT_COMPOSER_STACK_BAR_SHELL_CLASSES } from "./composerStackTokens";

// ==============================================
// Container Tokens
// ==============================================

export const INPUT_AREA = {
  /** Border radius for input container (chat panel / session creator) */
  borderRadius: 12,
  borderRadiusClass: "rounded-[12px]",

  /** Border radius for edit mode (slightly smaller) */
  borderRadiusEdit: 8,
  borderRadiusEditClass: "rounded-lg",

  /** Border radius for inner editor (ComposerInput) */
  borderRadiusEditor: 6,
  borderRadiusEditorClass: "rounded-md",

  /** Border */
  borderClass: "border border-solid border-border-2",
  borderColorVar: "var(--color-border-2)",

  /**
   * Hover + focus-within border and ring — flat, no drop shadow.
   * Rest: border-2. Hover (not focused): border-3. Focus-within: primary-6
   * border + a 2px primary ring (no diffuse glow).
   */
  shellInteractionClasses:
    "border border-solid border-border-2 transition-[border-color,box-shadow] duration-200 ease-in-out focus-within:border-primary-6 focus-within:shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-primary-6)_15%,transparent)] [&:not(:focus-within):hover]:border-border-3",

  /**
   * Sent user-message card in chat history — border only, no shadow, no focus
   * ring, no primary glow. Hover shows border-3. Click opens edit mode; while
   * editing the real input area (shellInteractionClasses) takes over.
   */
  shellInteractionClassesNoGlow:
    "border border-solid border-border-2 transition-[border-color] duration-200 ease-in-out hover:border-border-3",

  /**
   * Edit-message inline composer — border + focus-within ring only.
   * Drops the primary bottom-glow shadows used by the main composer so the
   * inline editor sitting under a sent user message stays visually quiet.
   * Rest: border-2. Hover (not focused): border-3. Focus-within: primary-6
   * border + a 2px primary ring, but no diffuse glow shadow.
   */
  shellEditInteractionClasses:
    "border border-solid border-border-2 transition-[border-color,box-shadow] duration-200 ease-in-out focus-within:border-primary-6 focus-within:shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-primary-6)_15%,transparent)] [&:not(:focus-within):hover]:border-border-3",

  /**
   * Queue + file-review bars above composer — same as `CHAT_COMPOSER_STACK_BAR_SHELL_CLASSES`.
   */
  compactFileChangesShellClasses: CHAT_COMPOSER_STACK_BAR_SHELL_CLASSES,

  /** Background - chat panel / embedded variant */
  backgroundChatPanel: "var(--color-chat-input)",
  backgroundChatPanelClass: "bg-chat-input",

  /** Background - default session creator */
  backgroundDefault: "var(--color-chat-input)",
  backgroundDefaultClass: "bg-chat-input",

  /** Background - edit mode */
  backgroundEdit: "var(--color-fill-1)",
  backgroundEditClass: "bg-fill-1",
} as const;

/** Shared full-height editor bounds for session and launchpad composers. */
export const INPUT_AREA_EDITOR_HEIGHT = {
  min: 60,
  max: 140,
} as const;

/** Shared editor presentation for session and creator composer surfaces. */
export const INPUT_AREA_EDITOR_CLASS =
  "session-editor flex-1 cursor-text overflow-y-auto rounded-md text-[14px] text-text-1";

/** Shared spacing for adjacent mode/model/source controls. */
export const INPUT_AREA_CONTROL_GROUP_CLASS =
  "flex min-w-0 items-center gap-px";

// ==============================================
// Padding Tokens
// ==============================================

/** Compact variant (chat panel embedded) */
export const INPUT_AREA_PADDING_COMPACT = {
  paddingX: 4,
  paddingXClass: "px-1",
  paddingTop: 12,
  paddingBottom: 4,
  gap: 4,
  gapClass: "gap-1",
} as const;

/** Default variant (standalone session creator) */
export const INPUT_AREA_PADDING_DEFAULT = {
  paddingX: 16,
  paddingXClass: "px-4",
  paddingTop: 16,
  paddingBottom: 16,
  gap: 8,
  gapClass: "gap-2",
} as const;

// ==============================================
// Toolbar / Button Tokens
// ==============================================

export const INPUT_AREA_BUTTONS = {
  /** Icon button size (px) */
  iconButtonSize: 28,
  iconButtonSizeClass: "h-7 w-7",

  /** Toolbar row height */
  toolbarHeight: 36,
  toolbarHeightClass: "h-9",

  /** Icon size */
  iconSize: 16,

  /**
   * Circular button base - matches Session Creator ControlButtons.
   *
   * Borderless on purpose: a hover-toggled `border` (even transparent → token)
   * pairs poorly with `transition-all`, and icons sitting at sub-pixel
   * coordinates can re-snap to whole pixels when the border paint flips,
   * producing a 1px vertical "shake". Hover is a paint-only `bg` swap so the
   * button stays in the main compositor layer.
   */
  iconButtonBase:
    "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-text-1 transition-colors duration-200 focus:outline-none hover:bg-bg-2",

  // Hover uses a darker/lighter brand shade (paint-only) rather than
  // `opacity-80`. Opacity transitions force Chromium to promote the
  // button to its own compositor layer on hover and demote on leave;
  // layer promotion rounds the layer origin to integer pixels, which
  // shifts a button sitting at a sub-pixel y to a whole-pixel y on
  // hover and back on leave — visually the ArrowUp icon shakes
  // vertically each time the cursor crosses the boundary. A pure
  // `background-color` swap stays in the main layer (paint-only), so
  // the button never moves. `primary-7` is the canonical "stronger"
  // shade in both light and dark themes (see primaryColors.ts).

  /** Circular button active/filled (submit when has content) */
  iconButtonActive:
    "cursor-pointer border-none bg-primary-6 text-white hover:bg-primary-5",

  /** Circular button inactive (submit when empty) - dimmed primary, no hover change */
  iconButtonInactive: "border-none bg-primary-6 text-white opacity-50",

  /** Trigger/dropdown open state (paint-only background) */
  triggerStateOpen: "bg-bg-2",
  /** Trigger/dropdown closed state (paint-only hover) */
  triggerStateClosed: "hover:bg-bg-2",

  /** Pill/trigger compact size (for model selector, etc.) */
  pillTriggerSize: "h-[28px] px-3 text-[12px]",
} as const;

// ==============================================
// Composite Class Strings
// ==============================================

export const INPUT_AREA_CLASSES = {
  /** Full container - chat panel variant (border/background via inline style) */
  containerChatPanel: [
    INPUT_AREA.borderRadiusClass,
    INPUT_AREA_PADDING_COMPACT.gapClass,
  ].join(" "),

  /** Editor inner (ComposerInput) */
  editorInner: INPUT_AREA.borderRadiusEditorClass,
} as const;

// ==============================================
// Chat Input Container Styles (matches Session Creator)
// ==============================================

/**
 * Expanded chat input container — border from `shellInteractionClasses` on the element.
 *
 * NOTE: `border-radius` is intentionally NOT set here. It is applied via the
 * `borderRadiusClass` Tailwind class so state-driven variants (e.g. pill shape
 * when unfocused+empty) can override it. Inline styles would win over classes.
 */
export const CHAT_INPUT_CONTAINER_STYLE: CSSProperties = {
  background: INPUT_AREA.backgroundChatPanel,
  paddingTop: INPUT_AREA_PADDING_COMPACT.paddingTop,
  paddingBottom: INPUT_AREA_PADDING_COMPACT.paddingBottom,
};
