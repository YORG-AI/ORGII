export type InputAreaPresentation =
  | "default"
  | "contextual"
  | "contextual-compact";

interface CompactComposerLayoutInput {
  presentation: InputAreaPresentation;
  isChatPanelMaximized: boolean;
  isEditMode: boolean;
  hasImages: boolean;
  isCiteCode: boolean;
  isReply: boolean;
  editorMultiline: boolean;
}

export function isContextualInputAreaPresentation(
  presentation: InputAreaPresentation
): boolean {
  return presentation !== "default";
}

/**
 * Resolve whether InputArea can use the shared one-row capsule without
 * hiding valid editor content. Contextual Canvas prompts opt into the capsule
 * even when ChatPanel itself is not maximized, then expand through the same
 * editor-multiline transition as the ordinary composer.
 */
export function shouldUseCompactComposerLayout({
  presentation,
  isChatPanelMaximized,
  isEditMode,
  hasImages,
  isCiteCode,
  isReply,
  editorMultiline,
}: CompactComposerLayoutInput): boolean {
  return (
    (isChatPanelMaximized || isContextualInputAreaPresentation(presentation)) &&
    !isEditMode &&
    !hasImages &&
    !isCiteCode &&
    !isReply &&
    !editorMultiline
  );
}
