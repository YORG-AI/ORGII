/**
 * Line-level LCS diff for the Canvas compare view — no external library.
 *
 * Memory: the classic full DP table is O(m×n) numbers; two canvases at the
 * line cap would allocate tens of megabytes per compare. This implementation
 * uses Hirschberg's divide-and-conquer, which only ever holds two rolling
 * Uint32Array rows, plus an exact common prefix/suffix trim so typical
 * revision diffs never reach the quadratic core at all.
 */

export type DiffLine =
  | { kind: "equal"; text: string }
  | { kind: "added"; text: string }
  | { kind: "removed"; text: string };

export const CANVAS_DIFF_MAX_LINES = 3_000;
export const CANVAS_DIFF_MAX_CHARS = 256 * 1024;

function countLines(text: string): number {
  let lines = 1;
  for (
    let index = text.indexOf("\n");
    index >= 0;
    index = text.indexOf("\n", index + 1)
  ) {
    lines += 1;
  }
  return lines;
}

/** Guard before diffing: O(m×n) work on megabyte inputs stalls the panel. */
export function isCanvasDiffInputTooLarge(
  oldText: string,
  newText: string
): boolean {
  if (
    oldText.length > CANVAS_DIFF_MAX_CHARS ||
    newText.length > CANVAS_DIFF_MAX_CHARS
  ) {
    return true;
  }
  return (
    countLines(oldText) > CANVAS_DIFF_MAX_LINES ||
    countLines(newText) > CANVAS_DIFF_MAX_LINES
  );
}

function pushRemoved(
  a: string[],
  from: number,
  to: number,
  out: DiffLine[]
): void {
  for (let index = from; index < to; index += 1) {
    out.push({ kind: "removed", text: a[index] });
  }
}

function pushAdded(
  b: string[],
  from: number,
  to: number,
  out: DiffLine[]
): void {
  for (let index = from; index < to; index += 1) {
    out.push({ kind: "added", text: b[index] });
  }
}

/** L[j] = LCS length of a[aStart..aEnd) versus b[bStart..bStart+j). */
function lcsLengthsForward(
  a: string[],
  aStart: number,
  aEnd: number,
  b: string[],
  bStart: number,
  bEnd: number
): Uint32Array {
  const n = bEnd - bStart;
  let previous = new Uint32Array(n + 1);
  let current = new Uint32Array(n + 1);
  for (let i = aStart; i < aEnd; i += 1) {
    for (let j = 0; j < n; j += 1) {
      current[j + 1] =
        a[i] === b[bStart + j]
          ? previous[j] + 1
          : Math.max(previous[j + 1], current[j]);
    }
    [previous, current] = [current, previous];
  }
  return previous;
}

/** L[j] = LCS length of a[aStart..aEnd) versus b[bStart+j..bEnd). */
function lcsLengthsBackward(
  a: string[],
  aStart: number,
  aEnd: number,
  b: string[],
  bStart: number,
  bEnd: number
): Uint32Array {
  const n = bEnd - bStart;
  let previous = new Uint32Array(n + 1);
  let current = new Uint32Array(n + 1);
  for (let i = aEnd - 1; i >= aStart; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      current[j] =
        a[i] === b[bStart + j]
          ? previous[j + 1] + 1
          : Math.max(previous[j], current[j + 1]);
    }
    [previous, current] = [current, previous];
  }
  return previous;
}

function diffCore(
  a: string[],
  aStart: number,
  aEnd: number,
  b: string[],
  bStart: number,
  bEnd: number,
  out: DiffLine[]
): void {
  const m = aEnd - aStart;
  const n = bEnd - bStart;
  if (m === 0) {
    pushAdded(b, bStart, bEnd, out);
    return;
  }
  if (n === 0) {
    pushRemoved(a, aStart, aEnd, out);
    return;
  }
  if (m === 1) {
    // Mirrors the previous full-table backtrack: additions up to the first
    // match of the single left line, or an immediate removal when it never
    // matches.
    const line = a[aStart];
    let matchIndex = -1;
    for (let j = bStart; j < bEnd; j += 1) {
      if (b[j] === line) {
        matchIndex = j;
        break;
      }
    }
    if (matchIndex < 0) {
      out.push({ kind: "removed", text: line });
      pushAdded(b, bStart, bEnd, out);
      return;
    }
    pushAdded(b, bStart, matchIndex, out);
    out.push({ kind: "equal", text: line });
    pushAdded(b, matchIndex + 1, bEnd, out);
    return;
  }
  if (n === 1) {
    const line = b[bStart];
    let matchIndex = -1;
    for (let i = aStart; i < aEnd; i += 1) {
      if (a[i] === line) {
        matchIndex = i;
        break;
      }
    }
    if (matchIndex < 0) {
      pushRemoved(a, aStart, aEnd, out);
      out.push({ kind: "added", text: line });
      return;
    }
    pushRemoved(a, aStart, matchIndex, out);
    out.push({ kind: "equal", text: line });
    pushRemoved(a, matchIndex + 1, aEnd, out);
    return;
  }

  const aMid = aStart + (m >> 1);
  const forward = lcsLengthsForward(a, aStart, aMid, b, bStart, bEnd);
  const backward = lcsLengthsBackward(a, aMid, aEnd, b, bStart, bEnd);
  let bestValue = -1;
  let split = bStart;
  for (let j = 0; j <= n; j += 1) {
    const value = forward[j] + backward[j];
    if (value > bestValue) {
      bestValue = value;
      split = bStart + j;
    }
  }
  diffCore(a, aStart, aMid, b, bStart, split, out);
  diffCore(a, aMid, aEnd, b, split, bEnd, out);
}

/** LCS-based line diff. Callers cap input via `isCanvasDiffInputTooLarge`. */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const result: DiffLine[] = [];

  // Exact trim: LCS(p + x + s, p + y + s) aligns p and s as equal lines and
  // leaves the interior alignment untouched, so trimming preserves output.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    result.push({ kind: "equal", text: a[start] });
    start += 1;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  diffCore(a, start, endA, b, start, endB, result);

  for (let index = endA; index < a.length; index += 1) {
    result.push({ kind: "equal", text: a[index] });
  }
  return result;
}
