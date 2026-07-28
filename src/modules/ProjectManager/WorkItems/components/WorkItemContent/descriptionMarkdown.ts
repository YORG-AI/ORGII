/**
 * Decode legacy Work Item descriptions that were stored as one line with
 * literal `\n` sequences instead of real line breaks.
 *
 * A single inline `\n` is left untouched so technical prose and code examples
 * keep their intended meaning.
 */
export function normalizeLegacyEscapedMarkdown(markdown: string): string {
  if (!markdown || /[\r\n]/.test(markdown)) return markdown;

  const escapedLineBreaks = markdown.match(/\\r\\n|\\n/g) ?? [];
  if (escapedLineBreaks.length === 0) return markdown;

  const hasEscapedMarkdownBlock =
    /(?:\\r\\n|\\n)[ \t]*(?:#{1,6}[ \t]|[-+*][ \t]|\d+[.)][ \t]|>[ \t]?|```)/.test(
      markdown
    );
  if (escapedLineBreaks.length < 2 && !hasEscapedMarkdownBlock) {
    return markdown;
  }

  return markdown.replace(/\\r\\n|\\n/g, "\n");
}
