interface InlineMentionQueryState {
  startOffset: number;
  hasAtChar?: boolean;
}

/**
 * Return only the text typed after an inline `@` trigger.
 *
 * Some WebKit event schedules can run the keydown fallback before the `@`
 * input event lands. In that case the fallback records the trigger's offset,
 * not the first query-character offset. `hasAtChar` lets us normalize both
 * schedules without exposing the literal `@` as the search query.
 */
export function getInlineMentionQuery(
  text: string,
  caretOffset: number,
  mention: InlineMentionQueryState
): string {
  const queryStart =
    mention.hasAtChar && text[mention.startOffset] === "@"
      ? mention.startOffset + 1
      : mention.startOffset;
  return text.slice(queryStart, caretOffset).replace(/\u200B/g, "");
}
