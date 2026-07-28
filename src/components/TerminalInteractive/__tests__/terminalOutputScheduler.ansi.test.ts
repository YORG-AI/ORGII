/**
 * ANSI parsing and boundary-safe terminal output scheduling tests.
 */
import { describe, expect, it, vi } from "vitest";

import {
  HIDDEN_BACKLOG_CAP,
  INITIAL_CHUNK_SIZE,
  ansiSequenceLength,
  findAnsiSafeSplit,
  registerPane,
  scheduleWrite,
  setPaneForeground,
} from "../terminalOutputScheduler";
import {
  SESSION_A,
  flushTimers,
  makeWrite,
} from "./terminalOutputScheduler.testSetup";

vi.mock("@src/util/platform/tauri/init", () => ({
  invokeTauri: vi.fn().mockResolvedValue(undefined),
  isTauriReady: vi.fn().mockReturnValue(true),
  listenTauri: vi.fn().mockResolvedValue(() => undefined),
}));

vi.mock("@src/hooks/logger", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ============================================
// ANSI sequence length
// ============================================

describe("ansiSequenceLength", () => {
  it("returns 0 for non-ESC character", () => {
    expect(ansiSequenceLength("hello", 0)).toBe(0);
  });

  it("returns 0 for bare ESC at end of string (incomplete)", () => {
    expect(ansiSequenceLength("\x1b", 0)).toBe(0);
  });

  it("measures CSI sequence ESC[33m (5 chars)", () => {
    const s = "\x1b[33m";
    expect(ansiSequenceLength(s, 0)).toBe(5);
  });

  it("measures CSI sequence ESC[1;32m (7 chars)", () => {
    const s = "\x1b[1;32m";
    expect(ansiSequenceLength(s, 0)).toBe(7);
  });

  it("measures reset ESC[0m (4 chars)", () => {
    expect(ansiSequenceLength("\x1b[0m", 0)).toBe(4);
  });

  it("returns 0 for incomplete CSI (no final byte)", () => {
    expect(ansiSequenceLength("\x1b[33", 0)).toBe(0);
  });

  it("measures OSC sequence terminated by BEL", () => {
    const s = "\x1b]0;title\x07";
    expect(ansiSequenceLength(s, 0)).toBe(s.length);
  });

  it("measures OSC sequence terminated by ST (ESC backslash)", () => {
    const s = "\x1b]0;title\x1b\\";
    expect(ansiSequenceLength(s, 0)).toBe(s.length);
  });

  it("returns 0 for incomplete OSC", () => {
    expect(ansiSequenceLength("\x1b]0;title", 0)).toBe(0);
  });

  it("measures 2-char ESC sequence (ESC c = reset)", () => {
    expect(ansiSequenceLength("\x1bc", 0)).toBe(2);
  });

  it("measures character-set designate ESC ( B (3 chars)", () => {
    expect(ansiSequenceLength("\x1b(B", 0)).toBe(3);
  });

  it("measures from a non-zero offset", () => {
    const s = "abc\x1b[32mdef";
    expect(ansiSequenceLength(s, 3)).toBe(5); // ESC[32m
  });
});

// ============================================
// findAnsiSafeSplit
// ============================================

describe("findAnsiSafeSplit", () => {
  it("returns targetPos for plain ASCII with no sequences", () => {
    const s = "hello world";
    expect(findAnsiSafeSplit(s, 5)).toBe(5);
  });

  it("never splits inside a CSI sequence", () => {
    // "abc\x1b[33mdef" — split target = 4 (inside the ESC sequence)
    const s = "abc\x1b[33mdef";
    const split = findAnsiSafeSplit(s, 4);
    // The CSI starts at index 3 and ends at 8. A safe split must be <=3
    expect(split).toBeLessThanOrEqual(3);
    // Verify: substring up to split does not start an incomplete sequence
    const prefix = s.slice(0, split);
    expect(prefix).not.toContain("\x1b[33");
  });

  it("allows splitting immediately after a complete sequence", () => {
    const s = "\x1b[33mhello";
    // After the 5-char CSI, index 5 is safe
    const split = findAnsiSafeSplit(s, 5);
    expect(split).toBe(5);
  });

  it("returns 0 if sequence at start crosses targetPos", () => {
    // Large OSC that extends beyond targetPos=3
    const s = "\x1b]0;long title\x07rest";
    const split = findAnsiSafeSplit(s, 3);
    expect(split).toBe(0);
  });

  it("handles multiple sequences correctly", () => {
    // "\x1b[1m" = indices 0-4 (5 chars)
    // "hello"   = indices 5-9
    // "\x1b[0m" = indices 9-12 (ESC at 9, [ at 10, 0 at 11, m at 12)
    // "world"   = indices 13-17
    const s = "\x1b[1mhello\x1b[0mworld";
    // targetPos=13 is the first char of "world" — the safe split at or before
    // 13 is 13 (we can include the leading 'w').
    const split = findAnsiSafeSplit(s, 13);
    // The split should be 13: boundary falls after the reset sequence ends at 12
    expect(split).toBe(13);
    // Verify the prefix ends cleanly
    const prefix = s.slice(0, split);
    expect(prefix).toBe("\x1b[1mhello\x1b[0m");
  });

  it("handles surrogate pair boundary", () => {
    // Unicode emoji (U+1F600) encodes as surrogate pair \uD83D\uDE00 in JS strings
    const emoji = "\uD83D\uDE00";
    const s = "ab" + emoji + "cd";
    // targetPos=3 would land inside the surrogate pair — safe split is 2
    const split = findAnsiSafeSplit(s, 3);
    expect(split).toBe(2);
  });

  it("returns s.length when targetPos >= s.length", () => {
    expect(findAnsiSafeSplit("hello", 100)).toBe(5);
  });
});

// ============================================
// ANSI-aware chunk splitting
// ============================================

describe("ANSI-aware chunk splitting", () => {
  it("does not split mid-CSI-sequence when data straddles chunk boundary", async () => {
    const { fn, calls } = makeWrite();
    registerPane(SESSION_A, fn);
    setPaneForeground(SESSION_A, true);

    // Build data where an ANSI sequence straddles the default chunk boundary.
    // We override chunkSize by using a very small INITIAL_CHUNK_SIZE equivalent
    // by filling exactly INITIAL_CHUNK_SIZE bytes, then appending an ANSI sequence.
    // Since we can't change the constant externally, we test the helper directly
    // and also verify the integration path never corrupts.

    const plain = "x".repeat(50);
    const seq = "\x1b[1;32mHELLO\x1b[0m";
    const data = plain + seq;
    scheduleWrite(SESSION_A, data, data.length, fn);

    await flushTimers();

    // All written data stitched together must equal the original
    const received = calls.join("");
    expect(received).toBe(data);
  });

  it("each written chunk has no dangling incomplete ESC sequences", async () => {
    const { fn, calls } = makeWrite();
    registerPane(SESSION_A, fn);
    setPaneForeground(SESSION_A, true);

    // Create data larger than MAX_CHUNK_SIZE to force multiple splits,
    // with ANSI sequences scattered throughout
    const parts: string[] = [];
    for (let i = 0; i < 10; i++) {
      parts.push("x".repeat(8192)); // 8 KB plain
      parts.push(`\x1b[${30 + i}m`); // colour sequence
      parts.push("text");
      parts.push("\x1b[0m"); // reset
    }
    const bigData = parts.join("");
    scheduleWrite(SESSION_A, bigData, bigData.length, fn);

    await flushTimers();

    // No chunk should end with a bare ESC followed by [ and then no final byte
    for (const chunk of calls) {
      // A chunk ending with ESC indicates a split mid-sequence
      const endsWithEsc = chunk.endsWith("\x1b");
      expect(endsWithEsc).toBe(false);
      // A chunk ending with ESC[ (no final byte) is also bad
      const endsWithCsiOpen = chunk.endsWith("\x1b[");
      expect(endsWithCsiOpen).toBe(false);
    }

    // Total output must be lossless
    expect(calls.join("")).toBe(bigData);
  });
});

// ============================================
// O5: findAnsiSafeSplit fromPos parameter
// ============================================

describe("findAnsiSafeSplit — fromPos (O5)", () => {
  it("fromPos=0 behaves identically to the no-arg form (backward compat)", () => {
    const s = "abc\x1b[33mdef";
    expect(findAnsiSafeSplit(s, 4, 0)).toBe(findAnsiSafeSplit(s, 4));
  });

  it("fast path: fromPos >= targetPos returns targetPos without scanning", () => {
    // Plain ASCII — safe to split anywhere; fromPos already past target.
    const s = "hello world";
    expect(findAnsiSafeSplit(s, 5, 7)).toBe(5);
  });

  it("fast path: fromPos === targetPos returns targetPos", () => {
    const s = "hello world";
    expect(findAnsiSafeSplit(s, 5, 5)).toBe(5);
  });

  it("resumes scan correctly after a known-safe boundary", () => {
    // "\x1b[1m" = ESC [ 1 m = 4 chars (indices 0-3)
    // "x".repeat(10) = indices 4-13
    // "\x1b[0m" = ESC [ 0 m = 4 chars (indices 14-17), total length 18
    const s = "\x1b[1m" + "x".repeat(10) + "\x1b[0m";
    expect(s.length).toBe(18);

    // First split: target=10, fromPos=0 — scans ESC[1m (ends at 4), then plain
    // chars 4..9. At i=10 <= targetPos=10, lastSafe=10. Returns 10.
    const firstSplit = findAnsiSafeSplit(s, 10, 0);
    expect(firstSplit).toBe(10);

    // Second split: fromPos=10, target=14 — the char at index 14 is ESC which
    // starts ESC[0m (crosses target). Last safe before it is 14's boundary = 14.
    // Actually target=14: loop runs while i<14. Chars 10-13 are 'x', after i=14
    // loop exits. lastSafe=14. Returns 14.
    const secondSplit = findAnsiSafeSplit(s, 14, firstSplit);
    expect(secondSplit).toBe(14);

    // Third split: fromPos=14, target=18 (s.length) — ESC[0m is complete and
    // ends exactly at 18. findAnsiSafeSplit returns s.length when targetPos >= s.length.
    const thirdSplit = findAnsiSafeSplit(s, s.length, secondSplit);
    expect(thirdSplit).toBe(s.length);
  });

  it("correctly handles fromPos exactly at an ANSI sequence boundary", () => {
    // fromPos lands right at the end of a complete CSI sequence.
    const seq = "\x1b[32m"; // 5 chars
    const s = seq + "hello" + "\x1b[0m" + "world";
    // fromPos=5 is exactly at the end of ESC[32m — a valid safe boundary.
    const split = findAnsiSafeSplit(s, 10, 5);
    // Range [5..10] is all plain ASCII; safe split is 10.
    expect(split).toBe(10);
  });

  it("does not produce mid-sequence split when fromPos is within plain text", () => {
    // fromPos in the middle of plain text, sequence comes after.
    // "aaaaaa\x1b[33mbb" — fromPos=3, target=8 (inside sequence)
    const s = "aaaaaa\x1b[33mbb";
    const split = findAnsiSafeSplit(s, 8, 3);
    // Safe boundary must be ≤ 6 (before the ESC)
    expect(split).toBeLessThanOrEqual(6);
    // Verify prefix integrity
    // eslint-disable-next-line no-control-regex
    expect(s.slice(0, split)).not.toMatch(/\x1b\[3$/);
  });

  it("returns fromPos (not 0) when no safe position found in the new window", () => {
    // The only content between fromPos and targetPos is an incomplete sequence.
    // "hello\x1b[33" — complete text "hello" (len 5) + incomplete CSI
    const s = "hello\x1b[33";
    // fromPos=5, target=8 — the ESC at 5 starts a sequence that doesn't finish
    const split = findAnsiSafeSplit(s, 8, 5);
    // No safe position found in [5..8]; lastSafe starts at fromPos=5
    expect(split).toBe(5);
  });
});

// ============================================
// O5: lastSafeSplitEnd cache in SchedulerEntry
// ============================================

describe("O5 — lastSafeSplitEnd cache reduces rescanning", () => {
  it("multi-chunk split of a large entry with OSC sequences: scanner resumes correctly", async () => {
    // Verify the O5 optimization via findAnsiSafeSplit's direct behaviour:
    // when fromPos equals the previously returned boundary, subsequent calls
    // produce the same boundaries as full-scan calls (correctness guarantee).
    const oscSeq = "\x1b]0;title\x07"; // 12 chars
    const block = "x".repeat(INITIAL_CHUNK_SIZE - oscSeq.length) + oscSeq;
    const data = block + block + block;

    // Simulate the split sequence that consumeChunk would perform.
    // Each step: full-scan result must equal incremental-scan result.
    const chunkSize = INITIAL_CHUNK_SIZE;
    let incrementalFromPos = 0;
    let start = 0;

    while (start < data.length) {
      const target = Math.min(start + chunkSize, data.length);

      const fullScan = findAnsiSafeSplit(data, target, 0);
      const incrementalScan = findAnsiSafeSplit(
        data,
        target,
        incrementalFromPos
      );

      expect(incrementalScan).toBe(fullScan);

      const splitAt = incrementalScan <= start ? data.length : incrementalScan;
      incrementalFromPos = splitAt;
      start = splitAt;
    }
  });

  it("first split of an entry starts from 0 (fromPos=0 matches no-arg)", () => {
    // The O5 invariant: fromPos=0 must be identical to a fresh scan (no-arg).
    const data = "x".repeat(INITIAL_CHUNK_SIZE) + "\x1b[32m" + "y".repeat(100);
    const target = INITIAL_CHUNK_SIZE + 3; // lands inside the ESC sequence

    expect(findAnsiSafeSplit(data, target, 0)).toBe(
      findAnsiSafeSplit(data, target)
    );
  });

  it("lossless output for large OSC-heavy burst across many chunks", async () => {
    const { fn, calls } = makeWrite();
    registerPane(SESSION_A, fn);
    setPaneForeground(SESSION_A, true);

    // 256 KB worth of OSC + plain text (simulates a real terminal title-update storm)
    const parts: string[] = [];
    const chunkCount = 16;
    const chunkBytes = 16 * 1024;
    for (let i = 0; i < chunkCount; i++) {
      parts.push(`\x1b]0;session-${i}\x07`); // ~18 chars OSC
      parts.push("y".repeat(chunkBytes - 20));
    }
    const data = parts.join("");
    scheduleWrite(SESSION_A, data, data.length, fn);
    await flushTimers();

    expect(calls.join("")).toBe(data);
  });
});

// ============================================
// Dangling escape-sequence repair after drops
// ============================================

describe("dangling escape repair", () => {
  it("never renders the orphaned tail of a sequence split across a drop", async () => {
    const { fn, calls } = makeWrite();
    registerPane(SESSION_A, fn);
    setPaneForeground(SESSION_A, false);

    // First chunk ends mid-CSI (ESC[38;2;26 without a final byte) and its
    // byteLength hint fills the whole cap; the second chunk overflows the
    // cap, so the first is dropped, orphaning the sequence tail.
    scheduleWrite(SESSION_A, "before\x1b[38;2;26", HIDDEN_BACKLOG_CAP, fn);
    scheduleWrite(SESSION_A, ";26;26mVISIBLE", 14, fn);

    await flushTimers();

    const joined = calls.join("");
    expect(joined).toContain("VISIBLE");
    expect(joined).not.toContain(";26;26mVISIBLE");
    expect(joined).toContain("backlog limit reached");
  });
});
