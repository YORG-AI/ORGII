/**
 * Segments push planning (design §7.3) + the shared OCC conflict matcher.
 *
 * `computeFrozenEventCount` / `splitFrozenIntoSegments` serve the cloud push
 * engine; `isCollabConflictError` additionally serves the ProjectSyncChannel.
 */
import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import type { SessionEventsSegmentInput } from "../sync/CollabSyncBackend";

/** displayStatus values after which an event no longer mutates in place. */
const TERMINAL_EVENT_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
]);

const PLAN_EVENT_FUNCTIONS: ReadonlySet<string> = new Set([
  "plan_approval",
  "create_plan",
]);

/** result.status values written only by the one-shot plan resolution chokepoint. */
const PLAN_RESOLUTION_STATUSES: ReadonlySet<string> = new Set([
  "approved",
  "archived",
  "cancelled",
]);

/**
 * Tools with no deferred completion path: their running→terminal merge can
 * only come from the turn executor that invoked them, never from a background
 * handle (unlike `agent` subagents via complete_parent_tool_call, or shells
 * via shellProcessStatus merges). A "running" stamp that survived past its
 * turn is a dropped-merge zombie that can never transition again. Additions
 * require verifying the tool has no late-completion path in agent-core.
 */
const SYNCHRONOUS_TOOL_KINDS: ReadonlySet<string> = new Set([
  "read_file",
  "code_search",
  "web_search",
  "web_fetch",
  "manage_code_map",
]);

const CREATE_PLAN_CALL_ID_PREFIX = "tool-call-";

function planRevisionOf(event: SessionEvent): string | null {
  const fromResult = event.result?.planRevisionId;
  if (typeof fromResult === "string" && fromResult) return fromResult;
  const fromArgs = event.args?.planRevisionId;
  if (typeof fromArgs === "string" && fromArgs) return fromArgs;
  if (typeof event.callId === "string" && event.callId) return event.callId;
  if (event.id.startsWith(CREATE_PLAN_CALL_ID_PREFIX)) {
    return event.id.slice(CREATE_PLAN_CALL_ID_PREFIX.length);
  }
  return null;
}

function isPlanFamilyEvent(event: SessionEvent): boolean {
  return (
    PLAN_EVENT_FUNCTIONS.has(event.functionName) ||
    PLAN_EVENT_FUNCTIONS.has(event.uiCanonical)
  );
}

interface StuckSentinelProof {
  resolvedPlanRevisions: ReadonlySet<string>;
  latestPendingCardIndex: number;
  latestPendingCardRevision: string | null;
  lastUserEventIndex: number;
}

function buildStuckSentinelProof(events: SessionEvent[]): StuckSentinelProof {
  const resolvedPlanRevisions = new Set<string>();
  let latestPendingCardIndex = -1;
  let latestPendingCardRevision: string | null = null;
  let lastUserEventIndex = -1;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.source === "user") lastUserEventIndex = index;
    if (!isPlanFamilyEvent(event)) continue;
    const resultStatus = event.result?.status;
    if (typeof resultStatus !== "string") continue;
    const revision = planRevisionOf(event);
    if (!revision) continue;
    if (PLAN_RESOLUTION_STATUSES.has(resultStatus)) {
      resolvedPlanRevisions.add(revision);
    } else if (resultStatus === "pending") {
      latestPendingCardIndex = index;
      latestPendingCardRevision = revision;
    }
  }
  return {
    resolvedPlanRevisions,
    latestPendingCardIndex,
    latestPendingCardRevision,
    lastUserEventIndex,
  };
}

/**
 * A non-terminal event may enter the frozen region only with an in-transcript
 * proof that its status can never transition again:
 *
 * - `awaiting_user` plan-family events whose revision was resolved
 *   (approved/archived/cancelled marker anywhere in the transcript — the
 *   resolution chokepoint is one-shot and deletes the pending row, so a
 *   resolved revision can never re-arm) or superseded (a later pending card
 *   for a different revision exists — the pending slot is single-occupancy
 *   and mark_ready archives the previous revision). A dangling
 *   `awaiting_user` here means only the status patch was dropped.
 * - `running` events of synchronous-only tools once a later user-source
 *   event exists: the invoking turn is over and no handle remains that could
 *   deliver the terminal merge.
 *
 * Everything else non-terminal (a genuinely pending plan card, running
 * backgroundable tools, `pending`, `ask_user_questions`) can still mutate in
 * place — arbitrarily late — and must stay in the mutable tail.
 */
function isProvablyStuck(
  event: SessionEvent,
  index: number,
  proof: StuckSentinelProof
): boolean {
  if (event.displayStatus === "awaiting_user" && isPlanFamilyEvent(event)) {
    const revision = planRevisionOf(event);
    if (!revision) return false;
    if (proof.resolvedPlanRevisions.has(revision)) return true;
    return (
      proof.latestPendingCardIndex > index &&
      proof.latestPendingCardRevision !== null &&
      proof.latestPendingCardRevision !== revision
    );
  }
  if (event.displayStatus === "running") {
    return (
      (SYNCHRONOUS_TOOL_KINDS.has(event.functionName) ||
        SYNCHRONOUS_TOOL_KINDS.has(event.uiCanonical)) &&
      proof.lastUserEventIndex > index
    );
  }
  return false;
}

/**
 * Frozen line (design §7.2): the frozen region is the longest event PREFIX
 * whose every event carries a terminal displayStatus ("completed"/"failed")
 * or is a provably-stuck sentinel (see `isProvablyStuck`). The first
 * still-mutable "running" / "pending" / "awaiting_user" event and everything
 * after it belong to the mutable tail — without the stuck-sentinel skip-over,
 * one dropped status patch pins the frozen line forever and every push
 * re-uploads an ever-growing tail (quadratic cumulative upload). Events with
 * no displayStatus (should not happen — Rust always stamps it) count as
 * terminal: a later in-place mutation is still caught by the per-event hash
 * chain and only costs an epoch rewrite, whereas treating them as
 * non-terminal would pin the frozen line forever. The same hash chain backs
 * the skip-over: if a "provably" stuck event does mutate after all, the push
 * detects the chain mismatch and re-anchors with one epoch rewrite.
 */
/** Recently-terminal events are still amendable by the ingest (tool-result
 * backfill, synthetic-input cleanup): terminal ≠ immutable. Freezing them
 * turns every amendment into a full epoch rewrite of the whole history, so
 * the freeze line holds back events younger than this horizon; amendments
 * then land in the mutable tail (one small segment re-upload). A quiescent
 * session has nothing inside the horizon and freezes to the end. */
const FREEZE_MUTATION_HORIZON_MS = 10 * 60_000;
/** Bound on horizon holdback — the tail ships as ONE segment, so a busy
 * span must not grow it without limit. Events older than the horizon or
 * beyond this cap freeze even while the session is live. */
const FREEZE_HORIZON_MAX_EVENTS = 40;

/**
 * Rust stamps an unpaired tool_call start (no result chunk in the file yet)
 * as "completed" so historical sessions never render a permanent spinner
 * (`infer_display_status`, normalizer.rs). That stamp is a UI kindness, not
 * an immutability proof: when the result lands in a later scan,
 * `merge_tool_call_pairs` rewrites the START event in place (args and result
 * fuse, the end chunk vanishes, later indices shift). Freezing such an event
 * turns every late tool completion into a full O(total) epoch rewrite —
 * background shells, subagents, and task notifications routinely complete
 * tens of minutes and dozens of events after their start, far beyond the
 * mutation horizon; live external-history sessions paid one rewrite per boot
 * this way (diagnosed 2026-08-07 on real transcripts). While the session is
 * still appending, the freeze line therefore stops at the first unresolved
 * pairing. A quiescent session freezes through them: results only arrive
 * while the file is growing, so its orphans are permanent. The cap bounds
 * the holdback so one abandoned call inside a busy live session cannot pin
 * the line into quadratic tail re-uploads — deeper orphans freeze, and a
 * late completion there pays the (rare) epoch rewrite as before.
 */
const FREEZE_PENDING_TOOL_MAX_HOLDBACK_EVENTS = 200;

/** A tool-call start whose pairing merge may still arrive (mirrors the Rust
 * merger's `is_tool_call_start`: call identity present, result still empty). */
function isUnresolvedToolCallStart(event: SessionEvent): boolean {
  const isToolCallLike =
    event.actionType === "tool_call" ||
    (typeof event.callId === "string" && event.callId.length > 0);
  if (!isToolCallLike) return false;
  const result = event.result as Record<string, unknown> | null | undefined;
  if (result == null) return true;
  return Object.keys(result).length === 0;
}

export function computeFrozenEventCount(
  events: SessionEvent[],
  nowMs: number = Date.now()
): number {
  let proof: StuckSentinelProof | null = null;
  let line = events.length;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const status = event?.displayStatus;
    if (typeof status === "string" && !TERMINAL_EVENT_STATUSES.has(status)) {
      proof ??= buildStuckSentinelProof(events);
      if (!isProvablyStuck(event, index, proof)) {
        line = index;
        break;
      }
    }
  }
  const horizonFloor = nowMs - FREEZE_MUTATION_HORIZON_MS;
  const lastCreatedAt = Date.parse(events[events.length - 1]?.createdAt ?? "");
  const sessionStillAppending =
    Number.isFinite(lastCreatedAt) && lastCreatedAt >= horizonFloor;
  const holdbackScanFloor = Math.max(
    0,
    events.length - FREEZE_PENDING_TOOL_MAX_HOLDBACK_EVENTS
  );
  // Position-unstable trailing events must never freeze. Some reader-emitted
  // chunks FLOAT at the stream end (observed: a synthetic task_create pinned
  // at count-2 whose positional seq — embedded in the event id — shifts on
  // every append); freezing one guarantees a chain mismatch on the next read
  // while the file grows, which is exactly the every-pass epoch-rewrite
  // bleed. Floaters betray themselves by timestamp inversion: an event
  // created long before the maximum createdAt already seen upstream is
  // sitting far from its chronological position. The horizon-sized slack
  // keeps ms-level interleaving inversions (parallel writers, clock jitter)
  // from triggering. This holdback applies even to quiescent sessions — a
  // floater frozen while quiet would still move (and pay a rewrite) on the
  // next reactivation append.
  let maxSeenCreatedAtMs = 0;
  for (let index = 0; index < holdbackScanFloor; index += 1) {
    const t = Date.parse(events[index]?.createdAt ?? "");
    if (Number.isFinite(t) && t > maxSeenCreatedAtMs) maxSeenCreatedAtMs = t;
  }
  for (let index = holdbackScanFloor; index < line; index += 1) {
    const event = events[index];
    const t = Date.parse(event?.createdAt ?? "");
    const floating =
      Number.isFinite(t) &&
      maxSeenCreatedAtMs > 0 &&
      t < maxSeenCreatedAtMs - FREEZE_MUTATION_HORIZON_MS;
    if (
      floating ||
      (sessionStillAppending && isUnresolvedToolCallStart(event))
    ) {
      line = index;
      break;
    }
    if (Number.isFinite(t) && t > maxSeenCreatedAtMs) maxSeenCreatedAtMs = t;
  }
  let held = 0;
  while (line > 0 && held < FREEZE_HORIZON_MAX_EVENTS) {
    // Only a PROVABLY recent event is held back; a missing/invalid
    // timestamp freezes as before (the hash chain still catches mutation).
    const createdAt = Date.parse(events[line - 1]?.createdAt ?? "");
    if (!Number.isFinite(createdAt) || createdAt < horizonFloor) break;
    line -= 1;
    held += 1;
  }
  return line;
}

/** Per-segment size budget (design §7.3 step 3a), measured pre-gzip. */
const SEGMENT_MAX_BYTES = 256 * 1024;

const segmentBudgetEncoder = new TextEncoder();

/**
 * Greedily pack frozen events into ≤256KB segments (at least one event per
 * segment, so an oversized single event still ships). `startSeq` is the seq
 * of the first produced segment. Budget is measured in canonical UTF-8
 * bytes — `String.length` counts UTF-16 code units and undercounts CJK/emoji
 * payloads by up to 3×, silently blowing the wire budget.
 */
export function splitFrozenIntoSegments(
  events: SessionEvent[],
  startSeq: number
): SessionEventsSegmentInput[] {
  const segments: SessionEventsSegmentInput[] = [];
  let current: SessionEvent[] = [];
  let currentBytes = 0;
  for (const event of events) {
    const eventBytes = segmentBudgetEncoder.encode(
      JSON.stringify(event)
    ).byteLength;
    if (current.length > 0 && currentBytes + eventBytes > SEGMENT_MAX_BYTES) {
      segments.push({ seq: startSeq + segments.length, events: current });
      current = [];
      currentBytes = 0;
    }
    current.push(event);
    currentBytes += eventBytes;
  }
  if (current.length > 0) {
    segments.push({ seq: startSeq + segments.length, events: current });
  }
  return segments;
}

/**
 * True for the server's opaque OCC rejection (append/rewrite anchors, the
 * project channel's whole-row upserts, lock acquisition): the self-hosted
 * plane raises `ORGII_CONFLICT`, the managed cloud raises `ORG2_CONFLICT`
 * (cloud-parity Phase B) — one dispatcher for both backends.
 */
export function isCollabConflictError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("ORGII_CONFLICT") ||
      error.message.includes("ORG2_CONFLICT"))
  );
}
