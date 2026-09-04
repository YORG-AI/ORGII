/**
 * Start message text on its first nonblank line without removing that line's
 * indentation or changing internal/trailing whitespace.
 */
export function stripLeadingBlankLines(text: string): string {
  return text.replace(/^(?:[^\S\r\n]*(?:\r\n?|\n|$))+/u, "");
}
