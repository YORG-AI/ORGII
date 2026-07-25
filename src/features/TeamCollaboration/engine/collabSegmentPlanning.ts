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
export function computeFrozenEventCount(events: SessionEvent[]): number {
  let proof: StuckSentinelProof | null = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const status = event?.displayStatus;
    if (typeof status === "string" && !TERMINAL_EVENT_STATUSES.has(status)) {
      proof ??= buildStuckSentinelProof(events);
      if (!isProvablyStuck(event, index, proof)) return index;
    }
  }
  return events.length;
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
