/**
 * Pure projections backing the derived per-session views. Kept free of React
 * so the layout maths and the aggregation rules are testable directly.
 *
 * Both read the same `TurnSummary[]` the session turn index already returns —
 * neither view needs event bodies, which is what keeps a whole-session view
 * affordable on long sessions.
 */
import type {
  TurnModifiedFile,
  TurnStatus,
  TurnSummary,
} from "@src/engines/SessionCore/storage/sqliteCache";

/** A zero-length turn still needs a visible bar. Ratio of the total span. */
export const MIN_TIMELINE_BAR_RATIO = 0.01;

export interface TimelineRow {
  turnId: string;
  /** 1-based position, shown as the row label prefix. */
  ordinal: number;
  preview: string;
  startedAtMs: number;
  endedAtMs: number | null;
  durationMs: number | null;
  /** True when a missing end was bounded by the following turn's start. */
  endInferred: boolean;
  /** Bar offset from the session start, 0..1 of the total span. */
  offsetRatio: number;
  /** Bar width, 0..1 of the total span, floored so every turn is visible. */
  widthRatio: number;
  status: TurnStatus;
  interrupted: boolean;
  fileCount: number;
  eventCount: number;
  commitCount: number;
}

export interface SessionTimeline {
  rows: TimelineRow[];
  /** Wall-clock span from the first turn's start to the last turn's end. */
  totalMs: number;
}

function parseTime(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Explicit end of a turn: its end stamp, or start + a stored duration. */
function explicitTurnEndMs(turn: TurnSummary, startMs: number): number | null {
  const ended = parseTime(turn.endedAt);
  if (ended !== null) return Math.max(startMs, ended);
  const duration =
    typeof turn.durationMs === "number" && Number.isFinite(turn.durationMs)
      ? Math.max(0, turn.durationMs)
      : null;
  return duration === null ? null : startMs + duration;
}

export function projectSessionTimeline(turns: TurnSummary[]): SessionTimeline {
  const timed = turns
    .map((turn) => ({ turn, startMs: parseTime(turn.startedAt) }))
    .filter(
      (entry): entry is { turn: TurnSummary; startMs: number } =>
        entry.startMs !== null
    );

  if (timed.length === 0) return { rows: [], totalMs: 0 };

  const resolved = timed.map((entry, index) => {
    const explicitEndMs = explicitTurnEndMs(entry.turn, entry.startMs);
    const nextStartMs = timed[index + 1]?.startMs ?? null;
    const inferredEndMs =
      explicitEndMs === null &&
      nextStartMs !== null &&
      nextStartMs >= entry.startMs
        ? nextStartMs
        : null;
    return {
      ...entry,
      endMs: explicitEndMs ?? inferredEndMs,
      endInferred: explicitEndMs === null && inferredEndMs !== null,
    };
  });

  const sessionStart = Math.min(...resolved.map((entry) => entry.startMs));
  const sessionEnd = Math.max(
    ...resolved.map((entry) => entry.endMs ?? entry.startMs)
  );
  // A session whose turns all share one instant has no span to divide by;
  // fall back to 1 so every ratio resolves to the minimum bar instead of NaN.
  const totalMs = Math.max(1, sessionEnd - sessionStart);

  const rows = resolved.map(({ turn, startMs, endMs, endInferred }, index) => {
    const barEndMs = endMs ?? startMs;
    const offsetRatio = (startMs - sessionStart) / totalMs;
    const rawWidth = (barEndMs - startMs) / totalMs;
    const widthRatio = Math.min(
      1 - offsetRatio,
      Math.max(MIN_TIMELINE_BAR_RATIO, rawWidth)
    );
    return {
      turnId: turn.turnId,
      ordinal: index + 1,
      preview: turn.userPreview,
      startedAtMs: startMs,
      endedAtMs: endMs,
      durationMs:
        typeof turn.durationMs === "number" && Number.isFinite(turn.durationMs)
          ? Math.max(0, turn.durationMs)
          : endMs !== null
            ? endMs - startMs
            : null,
      endInferred,
      offsetRatio,
      widthRatio,
      status: turn.status,
      interrupted: turn.interrupted,
      fileCount: turn.modifiedFiles.length,
      eventCount: turn.eventCount,
      commitCount: turn.gitArtifacts.length,
    };
  });

  return { rows, totalMs };
}

export interface ChangedFileRow {
  path: string;
  fileName: string;
  /**
   * Net status across the session: a file created then modified still reads
   * as "created", and a delete anywhere in the session wins — that is what the
   * session did to the file overall, not what its last turn did.
   */
  status: TurnModifiedFile["status"];
  additions: number;
  deletions: number;
  /** How many turns touched this path. */
  turnCount: number;
  /** First turn that touched it — the jump target from the row. */
  firstTurnId: string;
}

export interface SessionChanges {
  files: ChangedFileRow[];
  totalAdditions: number;
  totalDeletions: number;
}

function mergeStatus(
  current: TurnModifiedFile["status"],
  next: TurnModifiedFile["status"]
): TurnModifiedFile["status"] {
  if (current === "deleted" || next === "deleted") return "deleted";
  if (current === "created" || next === "created") return "created";
  return "modified";
}

export function projectSessionChanges(turns: TurnSummary[]): SessionChanges {
  const byPath = new Map<string, ChangedFileRow>();

  for (const turn of turns) {
    for (const file of turn.modifiedFiles) {
      const existing = byPath.get(file.path);
      if (!existing) {
        byPath.set(file.path, {
          path: file.path,
          fileName: file.fileName,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          turnCount: 1,
          firstTurnId: turn.turnId,
        });
        continue;
      }
      existing.status = mergeStatus(existing.status, file.status);
      existing.additions += file.additions;
      existing.deletions += file.deletions;
      existing.turnCount += 1;
    }
  }

  // Busiest files first: the ones a reviewer wants at the top are the ones the
  // session churned most, not the ones it happened to touch first.
  const files = Array.from(byPath.values()).sort(
    (a, b) =>
      b.additions + b.deletions - (a.additions + a.deletions) ||
      a.path.localeCompare(b.path)
  );

  return {
    files,
    totalAdditions: files.reduce((sum, file) => sum + file.additions, 0),
    totalDeletions: files.reduce((sum, file) => sum + file.deletions, 0),
  };
}
