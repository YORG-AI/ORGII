import type { SearchMatch, SearchResultFile } from "./types";

/**
 * Let the matches of one line share a single copy of that line.
 *
 * The Rust search reports, for every match, the text before it and after it
 * on the same line. A line with N matches therefore arrives N times over the
 * wire and, after `JSON.parse`, is held N times in the store: a minified
 * bundle line of 500 KB with 1,000 hits pins 500 MB. Here the line is rebuilt
 * once per (file, line) that has more than one match, and every match on it
 * gets its three strings re-derived as slices of that one line. JavaScript
 * engines back a slice with the parent string's storage (JSC and V8 both
 * do), so the line is retained once no matter how many matches it has.
 *
 * Lines with a single match, multi-line matches, and matches whose own
 * before/text/after do not reassemble the same line are passed through
 * untouched, so nothing observable changes: each match still reads exactly
 * what it did before.
 */
export function shareSearchLineContext(
  files: SearchResultFile[]
): SearchResultFile[] {
  return files.map(shareFileLineContext);
}

function shareFileLineContext(file: SearchResultFile): SearchResultFile {
  const matchesPerLine = new Map<number, number>();
  for (const match of file.matches) {
    if (match.line === match.end_line) {
      matchesPerLine.set(match.line, (matchesPerLine.get(match.line) ?? 0) + 1);
    }
  }
  let hasSharedLine = false;
  for (const count of matchesPerLine.values()) {
    if (count > 1) {
      hasSharedLine = true;
      break;
    }
  }
  if (!hasSharedLine) {
    return file;
  }

  const sharedLines = new Map<number, string>();
  const matches = file.matches.map((match): SearchMatch => {
    if (
      match.line !== match.end_line ||
      (matchesPerLine.get(match.line) ?? 0) < 2
    ) {
      return match;
    }
    const own = match.context_before + match.text + match.context_after;
    let line = sharedLines.get(match.line);
    if (line === undefined) {
      line = own;
      sharedLines.set(match.line, line);
    } else if (line !== own) {
      // Not the same line content after all; keep the match's own strings.
      return match;
    }
    const beforeLength = match.context_before.length;
    const textEnd = beforeLength + match.text.length;
    return {
      ...match,
      context_before: line.slice(0, beforeLength),
      text: line.slice(beforeLength, textEnd),
      context_after: line.slice(textEnd),
    };
  });
  return { ...file, matches };
}
