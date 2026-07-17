import type { Session } from "@src/store/session/sessionAtom/types";

export const SESSION_DATE_BUCKET_KEYS = [
  "today",
  "yesterday",
  "thisWeek",
  "older",
] as const;

export type SessionDateBucket = (typeof SESSION_DATE_BUCKET_KEYS)[number];

export interface SessionDateBucketRange {
  bucket: SessionDateBucket;
  startMs?: number;
  endMs?: number;
}

function localDayStart(now: Date, daysBeforeToday: number): number {
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() - daysBeforeToday
  ).getTime();
}

export function getSessionDateBucketRanges(
  now: Date = new Date()
): readonly SessionDateBucketRange[] {
  const today = localDayStart(now, 0);
  const yesterday = localDayStart(now, 1);
  const week = localDayStart(now, 7);
  return [
    { bucket: "today", startMs: today },
    { bucket: "yesterday", startMs: yesterday, endMs: today },
    { bucket: "thisWeek", startMs: week, endMs: yesterday },
    { bucket: "older", endMs: week },
  ];
}

export function getSessionDateBucket(
  session: Session,
  now: Date = new Date()
): SessionDateBucket {
  const timestamp =
    session.updated_at || session.updated_time || session.created_at;
  const timestampMs = timestamp ? new Date(timestamp).getTime() : Number.NaN;
  if (!Number.isFinite(timestampMs)) return "older";

  const ranges = getSessionDateBucketRanges(now);
  return (
    ranges.find(
      ({ startMs, endMs }) =>
        (startMs === undefined || timestampMs >= startMs) &&
        (endMs === undefined || timestampMs < endMs)
    )?.bucket ?? "older"
  );
}
