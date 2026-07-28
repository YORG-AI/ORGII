/**
 * Returns the length of a complete ANSI/VT escape sequence starting at
 * `pos`, or 0 when `pos` is not ESC or the sequence is incomplete.
 *
 * Handles CSI, OSC, DCS, APC, PM, SOS, character-set designation, DEC
 * private sequences, and ordinary two-character ESC sequences.
 */
export function ansiSequenceLength(s: string, pos: number): number {
  if (pos >= s.length || s.charCodeAt(pos) !== 0x1b) return 0;

  const next = pos + 1 < s.length ? s.charCodeAt(pos + 1) : -1;
  if (next === -1) return 0;

  // CSI: ESC [
  if (next === 0x5b) {
    let i = pos + 2;
    while (i < s.length) {
      const c = s.charCodeAt(i);
      if (c >= 0x40 && c <= 0x7e) return i - pos + 1;
      i++;
    }
    return 0;
  }

  // OSC: ESC ]
  if (next === 0x5d) {
    let i = pos + 2;
    while (i < s.length) {
      const c = s.charCodeAt(i);
      if (c === 0x07) return i - pos + 1;
      if (c === 0x1b && i + 1 < s.length && s.charCodeAt(i + 1) === 0x5c) {
        return i - pos + 2;
      }
      i++;
    }
    return 0;
  }

  // DCS / APC / PM / SOS — all ST-terminated.
  if (next === 0x50 || next === 0x5f || next === 0x5e || next === 0x58) {
    let i = pos + 2;
    while (i < s.length) {
      const c = s.charCodeAt(i);
      if (c === 0x1b && i + 1 < s.length && s.charCodeAt(i + 1) === 0x5c) {
        return i - pos + 2;
      }
      i++;
    }
    return 0;
  }

  // Designate character set: ESC ( / ) / * / + — followed by one char.
  if (next === 0x28 || next === 0x29 || next === 0x2a || next === 0x2b) {
    return pos + 2 < s.length ? 3 : 0;
  }

  // DEC private: ESC # digit.
  if (next === 0x23) {
    return pos + 2 < s.length ? 3 : 0;
  }

  // Everything else: ESC c, ESC =, ESC >, ESC 7/8, etc.
  return 2;
}

/**
 * Find a safe chunk boundary at or before `targetPos` without splitting an
 * ANSI escape sequence or UTF-16 surrogate pair.
 *
 * `fromPos` may resume the scan from a previously returned safe boundary,
 * reducing cumulative work from O(n²) to O(n) for a large queued entry.
 */
export function findAnsiSafeSplit(
  s: string,
  targetPos: number,
  fromPos: number = 0
): number {
  if (targetPos >= s.length) return s.length;
  if (targetPos <= 0) return 0;

  if (fromPos >= targetPos) return targetPos;

  const startPos = Math.max(0, fromPos);
  let i = startPos;
  let lastSafe = startPos;

  while (i < targetPos) {
    const c = s.charCodeAt(i);

    if (c === 0x1b) {
      const seqLen = ansiSequenceLength(s, i);
      if (seqLen === 0) return lastSafe;

      const seqEnd = i + seqLen;
      if (seqEnd <= targetPos) {
        i = seqEnd;
        lastSafe = i;
      } else {
        return lastSafe;
      }
    } else {
      if ((c & 0xfc00) === 0xd800 && i + 1 < s.length) {
        i += 2;
      } else {
        i += 1;
      }
      if (i <= targetPos) {
        lastSafe = i;
      }
    }
  }

  return lastSafe;
}
