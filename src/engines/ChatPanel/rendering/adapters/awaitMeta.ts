/**
 * `await_output` result parser — shared by TitleOnlyAdapter (wait_for /
 * monitor) and ToolCallBlock (list).
 *
 * Rust embeds a single `awaitMeta::{...json}` line in its raw tool-call
 * output (see `src-tauri/.../await_tool.rs`). This module centralises the
 * parse step so frontend sinks never touch the protocol directly.
 *
 * Canonical shapes:
 *
 *   wait_for / monitor → { count, items: AwaitJobItem[] }
 *   list               → { command: "list", status, count, items: AwaitListItem[] }
 *
 * Single-handle calls still emit `items: [one]` so consumers parse one shape.
 */

export type AwaitJobKind = "shell" | "subagent";

export type AwaitStatus = "running" | "succeeded" | "failed";

export type AwaitCommand = "wait_for" | "monitor" | "list";

/** One row of `awaitMeta.items` from a `wait_for` or `monitor` response. */
export interface AwaitJobItem {
  handle: string;
  jobKind: AwaitJobKind;
  status: AwaitStatus;
  /** Only present while `status === "running"`. */
  waitedMs?: number;
  /** Only present when a pattern was supplied (single-handle wait_for). */
  patternMatched?: boolean;
  matchLine?: string;
  exitCode?: number;
  killed?: boolean;
}

/** One row of `awaitMeta.items` from a `list` response. */
export interface AwaitListItem {
  handle: string;
  /** Free-form kind string from Rust (`"shell"`, `"subagent"`, etc.). */
  kind: string;
  status: AwaitStatus;
  ageMs: number;
  label: string;
}

export interface AwaitMeta {
  /** Only set for `list` responses. */
  command?: AwaitCommand;
  count?: number;
  /** wait_for / monitor items. Empty / undefined for `list`. */
  items?: AwaitJobItem[];
  /** `list` items (shape differs). */
  listItems?: AwaitListItem[];
  /** `list`-only top-level status ("succeeded"). */
  status?: AwaitStatus;
}

const AWAIT_META_PREFIX = "awaitMeta::";

/**
 * Parse the `awaitMeta::{...}` JSON line out of a raw tool-call result string.
 * Normalises the two `items` shapes into separate fields (`items` vs
 * `listItems`) so downstream consumers can type-narrow cleanly.
 */
export function parseAwaitMeta(raw: string | undefined): AwaitMeta | null {
  if (!raw) return null;
  const metaLine = raw
    .split("\n")
    .find((line) => line.startsWith(AWAIT_META_PREFIX));
  if (!metaLine) return null;
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(metaLine.slice(AWAIT_META_PREFIX.length));
  } catch {
    return null;
  }

  const command = json.command as AwaitCommand | undefined;
  const count =
    typeof json.count === "number" ? (json.count as number) : undefined;
  const status = json.status as AwaitStatus | undefined;
  const rawItems = Array.isArray(json.items)
    ? (json.items as Array<Record<string, unknown>>)
    : [];

  if (command === "list") {
    return {
      command,
      count,
      status,
      listItems: rawItems.map(normaliseListItem),
    };
  }

  return {
    command,
    count,
    status,
    items: rawItems.map(normaliseJobItem),
  };
}

function normaliseJobItem(raw: Record<string, unknown>): AwaitJobItem {
  return {
    handle: String(raw.handle ?? ""),
    jobKind: (raw.jobKind as AwaitJobKind) ?? "shell",
    status: (raw.status as AwaitStatus) ?? "running",
    waitedMs:
      typeof raw.waitedMs === "number" ? (raw.waitedMs as number) : undefined,
    patternMatched:
      typeof raw.patternMatched === "boolean"
        ? (raw.patternMatched as boolean)
        : undefined,
    matchLine:
      typeof raw.matchLine === "string" ? (raw.matchLine as string) : undefined,
    exitCode:
      typeof raw.exitCode === "number" ? (raw.exitCode as number) : undefined,
    killed:
      typeof raw.killed === "boolean" ? (raw.killed as boolean) : undefined,
  };
}

function normaliseListItem(raw: Record<string, unknown>): AwaitListItem {
  return {
    handle: String(raw.handle ?? ""),
    kind: String(raw.kind ?? ""),
    status: (raw.status as AwaitStatus) ?? "running",
    ageMs: typeof raw.ageMs === "number" ? (raw.ageMs as number) : 0,
    label: String(raw.label ?? ""),
  };
}

/**
 * Read a tool-call result bag and return the parsed `awaitMeta` payload.
 *
 * `UniversalEventProps.result` is a `Record<string, unknown>`; its shape
 * varies by upstream. In the common Rust path the raw text sits under
 * `output` (string) — but mock data and older flows sometimes place it on
 * `content` / `observation` / direct string values. Try each candidate
 * until one yields a meta line.
 */
export function readAwaitMetaFromResult(
  result: Record<string, unknown> | undefined
): AwaitMeta | null {
  if (!result) return null;
  const candidates: Array<unknown> = [
    result.output,
    result.content,
    result.observation,
    result.text,
    result,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string") {
      const parsed = parseAwaitMeta(candidate);
      if (parsed) return parsed;
    }
  }
  return null;
}

/**
 * Format a duration in milliseconds as `"Xm Ys"` / `"Ys"` (abbreviated).
 * Used by TitleOnly countdown rendering and "Waited 5s" done labels.
 */
export function formatDurationShort(ms: number | undefined): string {
  if (ms == null || ms <= 0) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return remainder > 0 ? `${minutes}m ${remainder}s` : `${minutes}m`;
  }
  return `${seconds}s`;
}

/** Tally of how many of each kind live in an `awaitMeta.items` array. */
export interface JobKindTally {
  shell: number;
  subagent: number;
  total: number;
}

/**
 * Count `items` by `jobKind`. Returns zeros when `items` is empty / absent —
 * callers can use `tally.total === 0` to tell when no structured info is
 * available (and fall back to a non-count label).
 */
export function tallyItems(items: AwaitJobItem[] | undefined): JobKindTally {
  const tally: JobKindTally = { shell: 0, subagent: 0, total: 0 };
  if (!items) return tally;
  for (const item of items) {
    tally.total += 1;
    if (item.jobKind === "shell") tally.shell += 1;
    else if (item.jobKind === "subagent") tally.subagent += 1;
  }
  return tally;
}
