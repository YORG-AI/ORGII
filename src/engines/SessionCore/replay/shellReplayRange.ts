import type { ShellReplayBookmark } from "@src/engines/SessionCore/core/types";

export const SHELL_REPLAY_RANGE_BYTES = 256 * 1024;
export const SHELL_REPLAY_CACHE_MAX_BYTES = 1024 * 1024;
// A cached window retains both raw frames (for future range merges) and its
// parsed visual rows. Keeping raw text to half the process-wide budget ensures
// the two representations together remain within the single 1MiB LRU.
export const SHELL_REPLAY_WINDOW_MAX_FRAME_BYTES = 512 * 1024;
export const SHELL_REPLAY_SETTLE_MS = 100;
const SHELL_REPLAY_VISUAL_SLICE_CHARS = 4 * 1024;

export interface ShellReplayFrame {
  /** Monotonic writer frame; ranges may return a watermark-truncated tail. */
  sequence: number;
  stream: "stdout" | "stderr";
  byteStart: number;
  byteEnd: number;
  text: string;
}

export interface ShellReplayRange {
  frames: ShellReplayFrame[];
  nextOffsetBytes: number;
  eof: boolean;
}

export interface ShellReplayVisualSpan {
  stream: "stdout" | "stderr";
  text: string;
}

export interface ShellReplayVisualRow {
  key: string;
  byteStart: number;
  byteEnd: number;
  spans: ShellReplayVisualSpan[];
}

export interface ShellReplayFrameWindow {
  frames: ShellReplayFrame[];
  rows: ShellReplayVisualRow[];
  earliestOffset: number;
  latestOffset: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function frameMemoryBytes(frame: ShellReplayFrame): number {
  return Math.max(
    frame.byteEnd - frame.byteStart,
    encoder.encode(frame.text).length
  );
}

export function replayFramesMemoryBytes(
  frames: readonly ShellReplayFrame[]
): number {
  return frames.reduce((total, frame) => total + frameMemoryBytes(frame), 0);
}

function truncateFrameToBytes(
  frame: ShellReplayFrame,
  allowedBytes: number
): ShellReplayFrame | null {
  if (allowedBytes <= 0) return null;
  const encoded = encoder.encode(frame.text);
  if (allowedBytes >= encoded.length) return frame;
  let safeLength = Math.min(allowedBytes, encoded.length);
  while (safeLength > 0 && (encoded[safeLength] & 0xc0) === 0x80) {
    safeLength -= 1;
  }
  const text = decoder.decode(encoded.slice(0, safeLength));
  const actualBytes = encoder.encode(text).length;
  if (actualBytes === 0) return null;
  return {
    ...frame,
    byteEnd: Math.min(frame.byteEnd, frame.byteStart + actualBytes),
    text,
  };
}

type AnsiParserState =
  | "text"
  | "escape"
  | "csi"
  | "osc"
  | "oscEscape"
  | "string"
  | "stringEscape";

/**
 * Turn append-only storage frames into real terminal text rows. Storage frame
 * boundaries are transport details, so they must never introduce a visual
 * newline. ANSI state is carried across frames and long logical lines are
 * sliced into bounded inline spans inside one row.
 */
export function buildShellReplayVisualRows(
  frames: readonly ShellReplayFrame[]
): ShellReplayVisualRow[] {
  const ordered = [...frames].sort(
    (left, right) =>
      left.byteStart - right.byteStart || left.sequence - right.sequence
  );
  const rows: ShellReplayVisualRow[] = [];
  let spans: ShellReplayVisualSpan[] = [];
  let rowStart: number | null = null;
  let rowEnd = 0;
  let ansiState: AnsiParserState = "text";
  let pendingCarriageReturn:
    | { stream: "stdout" | "stderr"; byteStart: number; byteEnd: number }
    | undefined;

  const appendText = (
    stream: "stdout" | "stderr",
    text: string,
    byteStart: number,
    byteEnd: number
  ) => {
    if (!text) return;
    rowStart ??= byteStart;
    rowEnd = Math.max(rowEnd, byteEnd);
    const previous = spans.at(-1);
    if (
      previous &&
      previous.stream === stream &&
      previous.text.length + text.length <= SHELL_REPLAY_VISUAL_SLICE_CHARS
    ) {
      previous.text += text;
      return;
    }
    spans.push({ stream, text });
  };

  const pushRow = (fallbackOffset: number) => {
    const byteStart = rowStart ?? fallbackOffset;
    rows.push({
      key: `${byteStart}:${rowEnd || fallbackOffset}`,
      byteStart,
      byteEnd: Math.max(rowEnd, fallbackOffset),
      spans,
    });
    spans = [];
    rowStart = null;
    rowEnd = fallbackOffset;
  };

  const consumeAnsi = (character: string): boolean => {
    const code = character.codePointAt(0) ?? 0;
    switch (ansiState) {
      case "text":
        if (character === "\u001b") {
          ansiState = "escape";
          return true;
        }
        return false;
      case "escape":
        if (character === "[") ansiState = "csi";
        else if (character === "]") ansiState = "osc";
        else if (character === "P" || character === "^" || character === "_") {
          ansiState = "string";
        } else {
          ansiState = "text";
        }
        return true;
      case "csi":
        if (code >= 0x40 && code <= 0x7e) ansiState = "text";
        return true;
      case "osc":
        if (character === "\u0007") ansiState = "text";
        else if (character === "\u001b") ansiState = "oscEscape";
        return true;
      case "oscEscape":
        ansiState = character === "\\" ? "text" : "osc";
        return true;
      case "string":
        if (character === "\u001b") ansiState = "stringEscape";
        return true;
      case "stringEscape":
        ansiState = character === "\\" ? "text" : "string";
        return true;
    }
  };

  for (const frame of ordered) {
    let sourceOffset = frame.byteStart;
    for (const character of frame.text) {
      const characterBytes = encoder.encode(character).length;
      const characterEnd = Math.min(
        frame.byteEnd,
        sourceOffset + characterBytes
      );

      if (consumeAnsi(character)) {
        sourceOffset = characterEnd;
        continue;
      }

      if (pendingCarriageReturn) {
        if (character !== "\n") {
          appendText(
            pendingCarriageReturn.stream,
            "\r",
            pendingCarriageReturn.byteStart,
            pendingCarriageReturn.byteEnd
          );
        }
        pendingCarriageReturn = undefined;
      }

      if (character === "\r") {
        pendingCarriageReturn = {
          stream: frame.stream,
          byteStart: sourceOffset,
          byteEnd: characterEnd,
        };
      } else if (character === "\n") {
        rowEnd = Math.max(rowEnd, characterEnd);
        pushRow(sourceOffset);
      } else {
        appendText(frame.stream, character, sourceOffset, characterEnd);
      }
      sourceOffset = characterEnd;
    }
  }

  if (pendingCarriageReturn) {
    appendText(
      pendingCarriageReturn.stream,
      "\r",
      pendingCarriageReturn.byteStart,
      pendingCarriageReturn.byteEnd
    );
  }
  if (spans.length > 0 || rows.length === 0) {
    const fallback = ordered.at(-1)?.byteEnd ?? 0;
    pushRow(fallback);
  }
  return rows;
}

/** Defense-in-depth: never render frames beyond the cursor's immutable watermark. */
export function filterFramesToBookmark(
  frames: readonly ShellReplayFrame[],
  bookmark: ShellReplayBookmark
): ShellReplayFrame[] {
  const filtered: ShellReplayFrame[] = [];
  for (const frame of frames) {
    if (
      frame.sequence > bookmark.visibleThroughSequence ||
      frame.byteStart >= bookmark.visibleBytes
    ) {
      continue;
    }
    const allowedBytes =
      Math.min(frame.byteEnd, bookmark.visibleBytes) - frame.byteStart;
    const safeFrame = truncateFrameToBytes(frame, allowedBytes);
    if (safeFrame) filtered.push(safeFrame);
  }
  return filtered.sort(
    (left, right) =>
      left.byteStart - right.byteStart || left.sequence - right.sequence
  );
}

export type ReplayWindowDirection = "initial" | "prepend" | "append";

export function mergeReplayFrameWindow(
  existing: readonly ShellReplayFrame[],
  incoming: readonly ShellReplayFrame[],
  bookmark: ShellReplayBookmark,
  direction: ReplayWindowDirection,
  maxBytes = SHELL_REPLAY_CACHE_MAX_BYTES
): ShellReplayFrame[] {
  const bySequence = new Map<number, ShellReplayFrame>();
  for (const frame of filterFramesToBookmark(
    [...existing, ...incoming],
    bookmark
  )) {
    // The backend returns complete append-only frames and may align a range
    // backwards to a frame boundary. A repeated sequence is the same frame.
    bySequence.set(frame.sequence, frame);
  }
  const merged = [...bySequence.values()].sort(
    (left, right) =>
      left.byteStart - right.byteStart || left.sequence - right.sequence
  );

  let totalBytes = replayFramesMemoryBytes(merged);
  while (merged.length > 1 && totalBytes > maxBytes) {
    const removed = direction === "prepend" ? merged.pop() : merged.shift();
    if (removed) totalBytes -= frameMemoryBytes(removed);
  }
  return merged;
}

export function replayWindowBounds(
  frames: readonly ShellReplayFrame[],
  response: ShellReplayRange,
  requestedOffset: number
): { earliest: number; latest: number } {
  const first = frames[0] ?? response.frames[0];
  const last = frames[frames.length - 1];
  return {
    earliest:
      first?.byteStart ?? Math.min(requestedOffset, response.nextOffsetBytes),
    // The backend may align the request backwards. Its continuation cursor is
    // authoritative and guarantees an append request still moves forward.
    latest: Math.max(last?.byteEnd ?? 0, response.nextOffsetBytes),
  };
}

interface CachedWindow {
  scopeKey: string;
  value: ShellReplayFrameWindow;
  sizeBytes: number;
}

function visualRowsMemoryBytes(rows: readonly ShellReplayVisualRow[]): number {
  return rows.reduce(
    (total, row) =>
      total +
      row.spans.reduce(
        (rowTotal, span) => rowTotal + encoder.encode(span.text).length,
        0
      ),
    0
  );
}

/**
 * The one process-wide replay payload budget. Components retain only a window
 * key and offsets in React state; all frame/row text lives in this evictable LRU.
 */
export class ShellReplayRangeCache {
  private readonly entries = new Map<string, CachedWindow>();
  private readonly listeners = new Set<() => void>();
  private sizeBytes = 0;
  private version = 0;

  constructor(
    private readonly maxBytes: number = SHELL_REPLAY_CACHE_MAX_BYTES
  ) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getVersion = (): number => this.version;

  private notify(): void {
    this.version += 1;
    for (const listener of this.listeners) listener();
  }

  peekWindow(
    key: string | null | undefined
  ): ShellReplayFrameWindow | undefined {
    return key ? this.entries.get(key)?.value : undefined;
  }

  readWindow(
    key: string | null | undefined
  ): ShellReplayFrameWindow | undefined {
    if (!key) return undefined;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  findCoveringWindow(
    scopeKey: string,
    startOffset: number,
    endOffset: number
  ): { key: string; value: ShellReplayFrameWindow } | undefined {
    for (const [key, entry] of [...this.entries].reverse()) {
      if (
        entry.scopeKey === scopeKey &&
        entry.value.earliestOffset <= startOffset &&
        entry.value.latestOffset >= endOffset
      ) {
        this.entries.delete(key);
        this.entries.set(key, entry);
        return { key, value: entry.value };
      }
    }
    return undefined;
  }

  setWindow(
    scopeKey: string,
    value: Omit<ShellReplayFrameWindow, "rows">
  ): string | null {
    const rows = buildShellReplayVisualRows(value.frames);
    const completeValue: ShellReplayFrameWindow = { ...value, rows };
    const key = JSON.stringify([
      scopeKey,
      value.earliestOffset,
      value.latestOffset,
    ]);
    const previous = this.entries.get(key);
    if (previous) this.sizeBytes -= previous.sizeBytes;
    this.entries.delete(key);

    const sizeBytes =
      replayFramesMemoryBytes(value.frames) + visualRowsMemoryBytes(rows);
    if (sizeBytes > this.maxBytes) {
      if (previous) this.notify();
      return null;
    }
    this.entries.set(key, { scopeKey, value: completeValue, sizeBytes });
    this.sizeBytes += sizeBytes;

    while (this.sizeBytes > this.maxBytes) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const oldest = this.entries.get(oldestKey);
      this.entries.delete(oldestKey);
      if (oldest) this.sizeBytes -= oldest.sizeBytes;
    }
    this.notify();
    return key;
  }

  clear(): void {
    this.entries.clear();
    this.sizeBytes = 0;
    this.notify();
  }

  get currentSizeBytes(): number {
    return this.sizeBytes;
  }
}

export const shellReplayRangeCache = new ShellReplayRangeCache();

export function shellReplayScopeKey(
  sessionId: string,
  callId: string,
  visibleThroughSequence: number,
  visibleBytes: number
): string {
  return JSON.stringify([
    sessionId,
    callId,
    visibleThroughSequence,
    visibleBytes,
  ]);
}

export function shellReplayRangeCacheKey(
  sessionId: string,
  callId: string,
  offsetBytes: number,
  limitBytes: number,
  visibleThroughSequence: number,
  visibleBytes: number
): string {
  return JSON.stringify([
    sessionId,
    callId,
    offsetBytes,
    limitBytes,
    visibleThroughSequence,
    visibleBytes,
  ]);
}
