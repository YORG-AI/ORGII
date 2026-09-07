import type { GitCommitInfo } from "@src/api/http/git/types";
import type { OrgtrackSessionEditArtifact } from "@src/api/tauri/lineage";
import type { KanbanTask } from "@src/features/KanbanBoard/types";
import { parseApiDate } from "@src/util/data/formatters/dateCore";

export const DIARY_EVENT_KIND = {
  Started: "started",
  Completed: "completed",
  StillWorking: "still_working",
} as const;

export type DiaryEventKind =
  (typeof DIARY_EVENT_KIND)[keyof typeof DIARY_EVENT_KIND];

export interface DiaryTimelineEvent {
  id: string;
  kind: DiaryEventKind;
  timestamp: Date;
  task: KanbanTask;
}

export interface DiaryCommitMarker {
  id: string;
  commit: GitCommitInfo;
  timestamp: Date;
  task: KanbanTask | undefined;
  sessionId: string | undefined;
}

export interface DiaryWorkInterval {
  id: string;
  task: KanbanTask;
  start: Date;
  end: Date;
  startsBeforeDay: boolean;
  endsAfterDay: boolean;
}

export interface DiaryDaySummary {
  dayStart: Date;
  engineeringMinutes: number;
  onlineMinutes: number;
  activeSessions: number;
  completedSessions: number;
  events: DiaryTimelineEvent[];
  workIntervals: DiaryWorkInterval[];
  commits: DiaryCommitMarker[];
}

interface WorkInterval {
  startMs: number;
  endMs: number;
}

const MIN_TERMINAL_WORK_MS = 30 * 60 * 1000;
const ORGTRACK_ACTIVITY_SPLIT_GAP_MS = 60 * 60 * 1000;

function getStartOfLocalDay(date: Date): Date {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    0,
    0,
    0,
    0
  );
}

function getEndOfLocalDay(date: Date): Date {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    23,
    59,
    59,
    999
  );
}

function isTerminalTask(task: KanbanTask): boolean {
  const status = task.status as string;
  return (
    status === "archived" ||
    status === "turn_finished" ||
    status === "done" ||
    status === "cancelled" ||
    task.resultStatus !== undefined
  );
}

function getTaskEnd(task: KanbanTask, start: Date, now: Date): Date {
  const terminal = isTerminalTask(task);
  const source = terminal
    ? (task.completed_at ?? task.updated_at ?? task.created_at)
    : now.toISOString();
  const parsedEnd = parseApiDate(source ?? now.toISOString()) ?? now;
  const cappedEnd = parsedEnd.getTime() > now.getTime() ? now : parsedEnd;

  if (cappedEnd.getTime() > start.getTime()) return cappedEnd;

  if (terminal && now.getTime() > start.getTime()) {
    return new Date(
      Math.min(start.getTime() + MIN_TERMINAL_WORK_MS, now.getTime())
    );
  }

  return start;
}

function overlapsDay(
  start: Date,
  end: Date,
  dayStart: Date,
  dayEnd: Date
): boolean {
  return (
    start.getTime() <= dayEnd.getTime() && end.getTime() >= dayStart.getTime()
  );
}

function pushEventIfInDay(
  events: DiaryTimelineEvent[],
  event: DiaryTimelineEvent,
  dayStart: Date,
  dayEnd: Date
): void {
  const timestampMs = event.timestamp.getTime();
  if (timestampMs >= dayStart.getTime() && timestampMs <= dayEnd.getTime()) {
    events.push(event);
  }
}

function mergeWorkIntervals(
  intervals: WorkInterval[],
  maxGapMs: number = 0
): WorkInterval[] {
  if (intervals.length === 0) return [];

  const sortedIntervals = [...intervals].sort(
    (firstInterval, secondInterval) => {
      const startDiff = firstInterval.startMs - secondInterval.startMs;
      if (startDiff !== 0) return startDiff;
      return firstInterval.endMs - secondInterval.endMs;
    }
  );

  const mergedIntervals: WorkInterval[] = [];
  let currentStartMs = sortedIntervals[0].startMs;
  let currentEndMs = sortedIntervals[0].endMs;

  for (const interval of sortedIntervals.slice(1)) {
    if (interval.startMs <= currentEndMs + maxGapMs) {
      currentEndMs = Math.max(currentEndMs, interval.endMs);
      continue;
    }

    mergedIntervals.push({ startMs: currentStartMs, endMs: currentEndMs });
    currentStartMs = interval.startMs;
    currentEndMs = interval.endMs;
  }

  mergedIntervals.push({ startMs: currentStartMs, endMs: currentEndMs });
  return mergedIntervals;
}

function calculateDedupedWorkMs(intervals: WorkInterval[]): number {
  return mergeWorkIntervals(intervals).reduce(
    (totalMs, interval) => totalMs + interval.endMs - interval.startMs,
    0
  );
}

function getOrgtrackArtifactTimeMs(
  artifact: OrgtrackSessionEditArtifact,
  now: Date
): number | null {
  const parsed = parseApiDate(artifact.timestamp);
  if (!parsed) return null;
  return Math.min(parsed.getTime(), now.getTime());
}

function getCommitTime(commit: GitCommitInfo): Date | null {
  return parseApiDate(commit.committer?.date || commit.author?.date);
}

export function buildDiaryCommitMarkers(
  commits: GitCommitInfo[],
  dayStart: Date,
  dayEnd: Date,
  tasks: KanbanTask[] = []
): DiaryCommitMarker[] {
  const sortedTasks = [...tasks].sort((firstTask, secondTask) => {
    const firstTime = parseApiDate(firstTask.created_at)?.getTime() ?? 0;
    const secondTime = parseApiDate(secondTask.created_at)?.getTime() ?? 0;
    return firstTime - secondTime;
  });

  const markers = commits
    .map((commit): DiaryCommitMarker | null => {
      const timestamp = getCommitTime(commit);
      if (!timestamp) return null;
      const timestampMs = timestamp.getTime();
      if (timestampMs < dayStart.getTime() || timestampMs > dayEnd.getTime()) {
        return null;
      }

      const task = findNearestTaskForCommit(timestamp, sortedTasks);
      return {
        id: `commit:${commit.sha}`,
        commit,
        timestamp,
        task,
        sessionId: task?.session_id,
      } satisfies DiaryCommitMarker;
    })
    .filter((marker): marker is DiaryCommitMarker => marker !== null);

  markers.sort((firstMarker, secondMarker) => {
    const diff =
      firstMarker.timestamp.getTime() - secondMarker.timestamp.getTime();
    if (diff !== 0) return diff;
    return firstMarker.commit.sha.localeCompare(secondMarker.commit.sha);
  });

  return markers;
}

function findNearestTaskForCommit(
  timestamp: Date,
  sortedTasks: KanbanTask[]
): KanbanTask | undefined {
  const timestampMs = timestamp.getTime();
  let bestTask: KanbanTask | undefined;
  let bestDistanceMs = Number.POSITIVE_INFINITY;

  for (const task of sortedTasks) {
    const start = parseApiDate(task.created_at);
    if (!start) continue;
    const completed = parseApiDate(task.completed_at ?? task.updated_at);
    const end = completed ?? start;
    const startMs = start.getTime();
    const endMs = Math.max(end.getTime(), startMs);

    const distanceMs =
      timestampMs < startMs
        ? startMs - timestampMs
        : timestampMs > endMs
          ? timestampMs - endMs
          : 0;

    if (distanceMs < bestDistanceMs) {
      bestDistanceMs = distanceMs;
      bestTask = task;
    }
  }

  return bestTask;
}

function buildOrgtrackWorkIntervals(
  artifacts: OrgtrackSessionEditArtifact[] | undefined,
  fallbackInterval: WorkInterval,
  now: Date
): WorkInterval[] {
  if (!artifacts || artifacts.length === 0) return [fallbackInterval];

  const sortedArtifactTimes = artifacts
    .map((artifact) => getOrgtrackArtifactTimeMs(artifact, now))
    .filter((timeMs): timeMs is number => timeMs !== null)
    .sort((firstTimeMs, secondTimeMs) => firstTimeMs - secondTimeMs);

  if (sortedArtifactTimes.length < 2) return [fallbackInterval];

  const splitIndexes = sortedArtifactTimes.flatMap((artifactTimeMs, index) => {
    if (index === 0) return [];
    const previousTimeMs = sortedArtifactTimes[index - 1];
    return artifactTimeMs - previousTimeMs > ORGTRACK_ACTIVITY_SPLIT_GAP_MS
      ? [index]
      : [];
  });

  if (splitIndexes.length === 0) return [fallbackInterval];

  const intervals: WorkInterval[] = [];
  let segmentStartMs = fallbackInterval.startMs;

  for (const splitIndex of splitIndexes) {
    const previousArtifactTimeMs = sortedArtifactTimes[splitIndex - 1];
    intervals.push({
      startMs: segmentStartMs,
      endMs: Math.max(segmentStartMs, previousArtifactTimeMs),
    });
    segmentStartMs = sortedArtifactTimes[splitIndex];
  }

  intervals.push({
    startMs: segmentStartMs,
    endMs: Math.max(segmentStartMs, fallbackInterval.endMs),
  });

  return intervals;
}

export function buildDiaryDaySummary(
  tasks: KanbanTask[],
  date: Date,
  now: Date = new Date(),
  orgtrackArtifactsBySessionId: ReadonlyMap<
    string,
    OrgtrackSessionEditArtifact[]
  > = new Map(),
  commits: GitCommitInfo[] = []
): DiaryDaySummary {
  const dayStart = getStartOfLocalDay(date);
  const dayEnd = getEndOfLocalDay(date);
  const uniqueActiveSessionIds = new Set<string>();
  const uniqueCompletedSessionIds = new Set<string>();
  const workIntervals: WorkInterval[] = [];
  const diaryWorkIntervals: DiaryWorkInterval[] = [];
  const events: DiaryTimelineEvent[] = [];
  let engineeringMs = 0;

  for (const task of tasks) {
    if (!task.created_at) continue;
    const parsedStart = parseApiDate(task.created_at);
    if (!parsedStart) continue;
    const start = parsedStart.getTime() > now.getTime() ? now : parsedStart;
    const end = getTaskEnd(task, start, now);

    if (!overlapsDay(start, end, dayStart, dayEnd)) continue;

    const fallbackInterval = { startMs: start.getTime(), endMs: end.getTime() };
    const sourceIntervals = buildOrgtrackWorkIntervals(
      task.session_id
        ? orgtrackArtifactsBySessionId.get(task.session_id)
        : undefined,
      fallbackInterval,
      now
    );

    for (const sourceInterval of sourceIntervals) {
      if (
        sourceInterval.startMs > dayEnd.getTime() ||
        sourceInterval.endMs < dayStart.getTime()
      ) {
        continue;
      }

      const clippedStartMs = Math.max(
        sourceInterval.startMs,
        dayStart.getTime()
      );
      const clippedEndMs = Math.min(sourceInterval.endMs, dayEnd.getTime());
      const durationMs = Math.max(0, clippedEndMs - clippedStartMs);
      engineeringMs += durationMs;
      if (durationMs > 0) {
        workIntervals.push({ startMs: clippedStartMs, endMs: clippedEndMs });
        diaryWorkIntervals.push({
          id: `${task.id}:work:${clippedStartMs}:${clippedEndMs}`,
          task,
          start: new Date(clippedStartMs),
          end: new Date(clippedEndMs),
          startsBeforeDay: sourceInterval.startMs < dayStart.getTime(),
          endsAfterDay: sourceInterval.endMs > dayEnd.getTime(),
        });
      }
    }
    uniqueActiveSessionIds.add(task.id);

    pushEventIfInDay(
      events,
      {
        id: `${task.id}:started`,
        kind: DIARY_EVENT_KIND.Started,
        timestamp: start,
        task,
      },
      dayStart,
      dayEnd
    );

    if (isTerminalTask(task)) {
      const completedInDay =
        end.getTime() >= dayStart.getTime() &&
        end.getTime() <= dayEnd.getTime();
      if (completedInDay) uniqueCompletedSessionIds.add(task.id);
      pushEventIfInDay(
        events,
        {
          id: `${task.id}:completed`,
          kind: DIARY_EVENT_KIND.Completed,
          timestamp: end,
          task,
        },
        dayStart,
        dayEnd
      );
    } else if (dayEnd.getTime() <= now.getTime()) {
      pushEventIfInDay(
        events,
        {
          id: `${task.id}:still-working:${dayEnd.getTime()}`,
          kind: DIARY_EVENT_KIND.StillWorking,
          timestamp: dayEnd,
          task,
        },
        dayStart,
        dayEnd
      );
    }
  }

  events.sort((firstEvent, secondEvent) => {
    const diff =
      firstEvent.timestamp.getTime() - secondEvent.timestamp.getTime();
    if (diff !== 0) return diff;
    return firstEvent.id.localeCompare(secondEvent.id);
  });

  return {
    dayStart,
    engineeringMinutes: Math.round(engineeringMs / 60_000),
    onlineMinutes: Math.round(calculateDedupedWorkMs(workIntervals) / 60_000),
    activeSessions: uniqueActiveSessionIds.size,
    completedSessions: uniqueCompletedSessionIds.size,
    events,
    workIntervals: diaryWorkIntervals,
    commits: buildDiaryCommitMarkers(commits, dayStart, dayEnd, tasks),
  };
}
