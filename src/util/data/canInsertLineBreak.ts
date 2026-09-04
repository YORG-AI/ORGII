/**
 * A line break replaces the current selection, so only the text before its
 * start can keep the first line nonblank. Later blank lines remain allowed.
 */
export function canInsertLineBreak(textBeforeSelection: string): boolean {
  const firstLine = textBeforeSelection.split(/\r\n?|\n/u, 1)[0];
  return /[^\s\u200B]/u.test(firstLine);
}
