import type { SimulatorEventPreview } from "../core/types";

/** Number of alternating low-saturation segment hues. */
export const REPLAY_TURN_SEGMENT_COLOR_COUNT = 6;

/** Minimum slider-span before merging a segment into its predecessor. */
export const REPLAY_TURN_MIN_SEGMENT_SPAN = 2;

export interface ReplayTurnSegment {
  turnId: string;
  turnNumber: number;
  startIndex: number;
  endIndex: number;
  startMs: number | null;
  endMs: number | null;
  durationMs: number;
  startValue: number;
  endValue: number;
  colorIndex: number;
  /** Pre-computed layout for the segment band (% of track width). */
  leftPercent: number;
  widthPercent: number;
}

export interface BuildReplayTurnSegmentsInput {
  eventIds: readonly string[];
  previewById: Readonly<Record<string, SimulatorEventPreview>>;
  maxValue: number;
  minSegmentSpan?: number;
}

function parseEpochMs(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** Matches chat turn headers: user-authored messages with visible text. */
export function isReplayTurnStartPreview(
  preview: SimulatorEventPreview | null | undefined
): boolean {
  if (!preview) return false;
  if (preview.functionName === "user_message") return true;
  return preview.source === "user" && Boolean(preview.displayText);
}

export function indexToReplaySliderValue(
  index: number,
  eventCount: number,
  maxValue: number
): number {
  if (eventCount <= 1) return 0;
  const clamped = Math.max(0, Math.min(eventCount - 1, index));
  return (clamped / (eventCount - 1)) * maxValue;
}

function mergeTinyReplayTurnSegments(
  segments: ReplayTurnSegment[],
  minSegmentSpan: number,
  maxValue: number
): ReplayTurnSegment[] {
  if (segments.length <= 1) return segments;

  const merged: ReplayTurnSegment[] = [];
  for (const segment of segments) {
    const span = segment.endValue - segment.startValue;
    const previous = merged.at(-1);
    if (previous && span < minSegmentSpan) {
      previous.endIndex = segment.endIndex;
      previous.endValue = Math.min(maxValue, segment.endValue);
      previous.endMs = segment.endMs ?? previous.endMs;
      if (previous.startMs !== null && previous.endMs !== null) {
        previous.durationMs = Math.max(0, previous.endMs - previous.startMs);
      }
      continue;
    }
    merged.push({ ...segment });
  }
  return merged;
}

/** Assign stable band geometry once segments and merges are finalized. */
export function applyReplayTurnSegmentLayout(
  segments: ReplayTurnSegment[],
  maxValue: number
): ReplayTurnSegment[] {
  if (maxValue <= 0 || segments.length === 0) return segments;

  return segments.map((segment, index) => {
    const displayEnd = segments[index + 1]?.startValue ?? maxValue;
    const leftPercent = (segment.startValue / maxValue) * 100;
    const rawWidth = ((displayEnd - segment.startValue) / maxValue) * 100;
    return {
      ...segment,
      leftPercent,
      widthPercent: Math.max(rawWidth, 0.75),
    };
  });
}

/**
 * Partition the effective simulator timeline into turn bands for the replay
 * scrubber. Turn boundaries follow the same user-message rule as chat grouping.
 */
export function buildReplayTurnSegments(
  input: BuildReplayTurnSegmentsInput
): ReplayTurnSegment[] {
  const {
    eventIds,
    previewById,
    maxValue,
    minSegmentSpan = REPLAY_TURN_MIN_SEGMENT_SPAN,
  } = input;

  if (eventIds.length === 0) return [];

  const turnStartIndices: number[] = [0];
  for (let index = 1; index < eventIds.length; index++) {
    const preview = previewById[eventIds[index]];
    if (isReplayTurnStartPreview(preview)) {
      turnStartIndices.push(index);
    }
  }

  const segments: ReplayTurnSegment[] = turnStartIndices.map(
    (startIndex, turnOffset) => {
      const nextStart = turnStartIndices[turnOffset + 1];
      const endIndex =
        nextStart !== undefined ? nextStart - 1 : eventIds.length - 1;
      const turnId = eventIds[startIndex];
      const startPreview = previewById[turnId];
      const endPreview = previewById[eventIds[endIndex]];
      const startMs = parseEpochMs(startPreview?.createdAt);
      const endMs = parseEpochMs(endPreview?.createdAt);
      const durationMs =
        startMs !== null && endMs !== null ? Math.max(0, endMs - startMs) : 0;

      return {
        turnId,
        turnNumber: turnOffset + 1,
        startIndex,
        endIndex,
        startMs,
        endMs,
        durationMs,
        startValue: indexToReplaySliderValue(
          startIndex,
          eventIds.length,
          maxValue
        ),
        endValue: indexToReplaySliderValue(endIndex, eventIds.length, maxValue),
        colorIndex: turnOffset % REPLAY_TURN_SEGMENT_COLOR_COUNT,
        leftPercent: 0,
        widthPercent: 0,
      };
    }
  );

  return applyReplayTurnSegmentLayout(
    mergeTinyReplayTurnSegments(segments, minSegmentSpan, maxValue),
    maxValue
  );
}

export function findActiveReplayTurnSegment(
  segments: readonly ReplayTurnSegment[],
  currentIndex: number
): ReplayTurnSegment | null {
  if (currentIndex < 0 || segments.length === 0) return null;
  return (
    segments.find(
      (segment) =>
        currentIndex >= segment.startIndex && currentIndex <= segment.endIndex
    ) ?? null
  );
}
