/**
 * ChatFontStyles - Unified font styling system for the chat panel
 *
 * Uses CSS variables to control font size, line height, and other styles
 */

// CSS Variables
export const CHAT_CSS_VARIABLES = {
  fontSize: "--chat-font-size",
  codeFontSize: "--chat-code-font-size",
  lineHeight: "--chat-line-height",
  compactSpacing: "--chat-compact-spacing",
} as const;

// Default values
export const CHAT_STYLE_DEFAULTS = {
  fontSize: 14,
  codeFontSize: 13,
  lineHeight: 1.6,
  compactSpacing: 8,
} as const;

// CSS Class names
export const CHAT_TEXT_CLASSES = {
  /** Main content text - uses --chat-font-size */
  text: "chat-text",
  /** Small text (font-size - 1px) - for secondary labels */
  textSm: "chat-text-sm",
  /** Extra small text (font-size - 2px) - for badges, timestamps */
  textXs: "chat-text-xs",
} as const;

export const CHAT_CODE_CLASSES = {
  /** Code blocks - uses --chat-code-font-size */
  code: "chat-code",
  /** Small code text (font-size - 1px) */
  codeSm: "chat-code-sm",
} as const;

/**
 * Generate inline CSS variables for chat styling
 */
export function getChatStyleVariables(config: {
  fontSize?: number;
  codeFontSize?: number;
  lineHeight?: number;
  compactSpacing?: number;
}): React.CSSProperties {
  return {
    [CHAT_CSS_VARIABLES.fontSize]: config.fontSize
      ? `${config.fontSize}px`
      : undefined,
    [CHAT_CSS_VARIABLES.codeFontSize]: config.codeFontSize
      ? `${config.codeFontSize}px`
      : undefined,
    [CHAT_CSS_VARIABLES.lineHeight]: config.lineHeight ?? undefined,
    [CHAT_CSS_VARIABLES.compactSpacing]: config.compactSpacing
      ? `${config.compactSpacing}px`
      : undefined,
  } as React.CSSProperties;
}

// Re-export for convenience
export type ChatTextClass = keyof typeof CHAT_TEXT_CLASSES;
export type ChatCodeClass = keyof typeof CHAT_CODE_CLASSES;
