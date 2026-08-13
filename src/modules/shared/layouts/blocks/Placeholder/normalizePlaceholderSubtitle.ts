/**
 * Placeholder subtitles are short supporting labels, not prose paragraphs.
 * Keep their visual rhythm consistent by dropping a final sentence period,
 * while preserving an intentional progress ellipsis.
 */
export function normalizePlaceholderSubtitle(
  subtitle: string | undefined
): string | undefined {
  if (!subtitle) return subtitle;

  const value = subtitle.trimEnd();
  const withoutTerminator = value.endsWith("。")
    ? value.replace(/。+$/u, "")
    : value.endsWith(".") && !value.endsWith("...")
      ? value.slice(0, -1)
      : value;

  return withoutTerminator || undefined;
}
