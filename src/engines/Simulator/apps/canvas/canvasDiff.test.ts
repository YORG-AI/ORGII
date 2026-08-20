import { describe, expect, it } from "vitest";

import {
  CANVAS_DIFF_MAX_CHARS,
  CANVAS_DIFF_MAX_LINES,
  type DiffLine,
  diffLines,
  isCanvasDiffInputTooLarge,
} from "./canvasDiff";

/**
 * The previous full-table O(m×n)-memory implementation, kept here as the
 * reference oracle for the linear-memory rewrite.
 */
function referenceDiffLines(oldText: string, newText: string): DiffLine[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0)
  );
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j]
          ? 1 + dp[i + 1][j + 1]
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      result.push({ kind: "equal", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ kind: "removed", text: a[i++] });
    } else {
      result.push({ kind: "added", text: b[j++] });
    }
  }
  while (i < m) result.push({ kind: "removed", text: a[i++] });
  while (j < n) result.push({ kind: "added", text: b[j++] });
  return result;
}

function reconstructOld(diff: DiffLine[]): string {
  return diff
    .filter((line) => line.kind !== "added")
    .map((line) => line.text)
    .join("\n");
}

function reconstructNew(diff: DiffLine[]): string {
  return diff
    .filter((line) => line.kind !== "removed")
    .map((line) => line.text)
    .join("\n");
}

function countKind(diff: DiffLine[], kind: DiffLine["kind"]): number {
  return diff.filter((line) => line.kind === kind).length;
}

/** Deterministic PRNG so failures reproduce. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("diffLines", () => {
  it("marks a single modified line between equal context", () => {
    expect(diffLines("a\nb\nc", "a\nB\nc")).toEqual([
      { kind: "equal", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "added", text: "B" },
      { kind: "equal", text: "c" },
    ]);
  });

  it("handles pure insertions, deletions, and identical inputs", () => {
    expect(diffLines("a\nc", "a\nb\nc")).toEqual([
      { kind: "equal", text: "a" },
      { kind: "added", text: "b" },
      { kind: "equal", text: "c" },
    ]);
    expect(diffLines("a\nb\nc", "a\nc")).toEqual([
      { kind: "equal", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "equal", text: "c" },
    ]);
    expect(diffLines("a\nb", "a\nb")).toEqual([
      { kind: "equal", text: "a" },
      { kind: "equal", text: "b" },
    ]);
    expect(diffLines("", "")).toEqual([{ kind: "equal", text: "" }]);
  });

  it("matches the full-table reference on completely disjoint inputs", () => {
    expect(diffLines("x\ny", "p\nq\nr")).toEqual(
      referenceDiffLines("x\ny", "p\nq\nr")
    );
  });

  it("produces minimal, reconstructable diffs equivalent to the full-table reference", () => {
    const random = mulberry32(0xc0ffee);
    const alphabet = ["alpha", "beta", "gamma", "delta"];
    for (let round = 0; round < 300; round += 1) {
      const lines = (count: number) =>
        Array.from(
          { length: count },
          () => alphabet[Math.floor(random() * alphabet.length)]
        ).join("\n");
      const oldText = lines(Math.floor(random() * 12));
      const newText = lines(Math.floor(random() * 12));

      const actual = diffLines(oldText, newText);
      const reference = referenceDiffLines(oldText, newText);

      // Both texts must be exactly reconstructable from the diff…
      expect(reconstructOld(actual)).toBe(oldText);
      expect(reconstructNew(actual)).toBe(newText);
      // …and the diff must be minimal: same LCS length as the reference.
      expect(countKind(actual, "equal")).toBe(countKind(reference, "equal"));
      expect(countKind(actual, "added")).toBe(countKind(reference, "added"));
      expect(countKind(actual, "removed")).toBe(
        countKind(reference, "removed")
      );
    }
  });

  it("skips the quadratic core for large inputs with a small edit", () => {
    const base = Array.from({ length: 2_500 }, (_, i) => `line ${i}`);
    const edited = [...base];
    edited[1_200] = "line changed";
    const diff = diffLines(base.join("\n"), edited.join("\n"));
    expect(countKind(diff, "removed")).toBe(1);
    expect(countKind(diff, "added")).toBe(1);
    expect(countKind(diff, "equal")).toBe(base.length - 1);
  });
});

describe("isCanvasDiffInputTooLarge", () => {
  it("caps by line count and by byte size", () => {
    const manyLines = "x\n".repeat(CANVAS_DIFF_MAX_LINES + 1);
    expect(isCanvasDiffInputTooLarge(manyLines, "small")).toBe(true);
    expect(isCanvasDiffInputTooLarge("small", manyLines)).toBe(true);

    const hugeLine = "y".repeat(CANVAS_DIFF_MAX_CHARS + 1);
    expect(isCanvasDiffInputTooLarge(hugeLine, "small")).toBe(true);

    expect(isCanvasDiffInputTooLarge("a\nb\nc", "a\nc")).toBe(false);
  });
});
