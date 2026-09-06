import { loadCanonicalConversationEvents } from "@src/engines/SessionCore/conversations/canonicalConversationEvents";
import { QueuedConversationRecoveryPendingError } from "@src/engines/SessionCore/conversations/queuedConversationContract";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { isOptimisticQueueUserEventId } from "@src/engines/SessionCore/services/userIntentDispatch";
import { loadCliTranscriptRevision } from "@src/engines/SessionCore/sync/adapters/cli/cliHistory";
import { turnIntentIdOf } from "@src/engines/SessionCore/sync/utils/activityIds";
import { invokeTauri } from "@src/util/platform/tauri/init";
import { isCliSession } from "@src/util/session/sessionDispatch";

import type { ConversationRootLocator } from "./conversationTypes";
import { conversationExecutionParentId } from "./localConversationContinuation";
import {
  nativeConversationEventSemanticKey,
  nativeConversationItemsAreProviderPortablePrefix,
  nativeSourceEventId,
  projectNativeConversationItems,
  sourceEventIdOfNativeItem,
} from "./nativeConversationMaterializer";

export const LOCAL_EXECUTION_TAIL_EVENT_PREFIX = "runlanded-";
const STABLE_CANONICAL_SNAPSHOT_ATTEMPTS = 2;

export interface LocalExecutionChild {
  session_id: string;
  created_at: string;
  /** Existing session catalog revision; used to refresh a reused native child. */
  updated_at?: string;
}

export interface LocalExecutionSegment {
  child: LocalExecutionChild;
  events: readonly SessionEvent[];
  /** Provider-file revision that bracketed this exact child read. */
  nativeRevision?: string | null;
}

export interface LocalCanonicalConversationSnapshot {
  events: SessionEvent[];
  /** Authoritative root retained for read-side tail projection. */
  rootEvents: SessionEvent[];
  /** Raw child segments read by the same consistent snapshot. */
  segments: LocalExecutionSegment[];
  /**
   * Stable catalog frontier covered by `events`. `null` means a child changed
   * while the snapshot was being read, so callers must not cache it as clean.
   */
  childRevision: string | null;
}

interface LocalExecutionChildRow {
  sessionId: string;
  createdAt?: string;
  updatedAt?: string;
}

export function resolveLocalExecutionChildren(
  children: readonly { sessionId: string }[],
  createdAtBySessionId: ReadonlyMap<string, string | undefined>,
  updatedAtBySessionId: ReadonlyMap<
    string,
    string | undefined
  > = createdAtBySessionId
): LocalExecutionChild[] {
  const resolved: LocalExecutionChild[] = [];
  const seen = new Set<string>();
  for (const child of children) {
    const createdAt = createdAtBySessionId.get(child.sessionId);
    if (!child.sessionId || !createdAt || seen.has(child.sessionId)) continue;
    seen.add(child.sessionId);
    resolved.push({
      session_id: child.sessionId,
      created_at: createdAt,
      updated_at: updatedAtBySessionId.get(child.sessionId) ?? createdAt,
    });
  }
  return resolved.sort((left, right) =>
    left.created_at.localeCompare(right.created_at)
  );
}

export async function loadLocalExecutionChildren(
  root: ConversationRootLocator
): Promise<LocalExecutionChild[]> {
  // The child-session command already joins Agent, CLI, and imported episode
  // catalogs into one authoritative row shape. Use its creation timestamp
  // directly; probing every provider adapter here both duplicated that owner
  // and could silently drop a valid child while an adapter was still waking.
  const children = await invokeTauri<LocalExecutionChildRow[]>(
    "es_get_child_sessions",
    {
      parentSessionId: conversationExecutionParentId(root),
    }
  );
  return resolveLocalExecutionChildren(
    children,
    new Map(children.map((child) => [child.sessionId, child.createdAt])),
    new Map(
      children.map((child) => [
        child.sessionId,
        child.updatedAt ?? child.createdAt,
      ])
    )
  );
}

function localExecutionChildrenRevision(
  children: readonly LocalExecutionChild[],
  nativeRevisions: ReadonlyMap<string, string | null | undefined> = new Map()
): string | null {
  if (
    children.some((child) => nativeRevisions.get(child.session_id) === null)
  ) {
    return null;
  }
  return JSON.stringify(
    children.map((child) => [
      child.session_id,
      child.created_at,
      child.updated_at ?? child.created_at,
      nativeRevisions.get(child.session_id) ?? "",
    ])
  );
}

const UNREADABLE_NATIVE_REVISION = "native-revision:unavailable";

async function loadLocalExecutionChildNativeRevision(
  sessionId: string
): Promise<string | undefined> {
  if (!isCliSession(sessionId)) return undefined;
  const revision = await loadCliTranscriptRevision(sessionId);
  return (
    revision ?? (revision === null ? UNREADABLE_NATIVE_REVISION : undefined)
  );
}

async function loadLocalExecutionChildrenState(
  root: ConversationRootLocator
): Promise<{
  children: LocalExecutionChild[];
  nativeRevisions: Map<string, string | null | undefined>;
  revision: string | null;
}> {
  const children = await loadLocalExecutionChildren(root);
  const revisions = await Promise.all(
    children.map((child) =>
      loadLocalExecutionChildNativeRevision(child.session_id)
    )
  );
  const nativeRevisions = new Map(
    children.map(
      (child, index) => [child.session_id, revisions[index]] as const
    )
  );
  return {
    children,
    nativeRevisions,
    revision: localExecutionChildrenRevision(children, nativeRevisions),
  };
}

export async function loadLocalExecutionChildrenRevision(
  root: ConversationRootLocator
): Promise<string | null> {
  return (await loadLocalExecutionChildrenState(root)).revision;
}

export function verifiedNativeConversationSuffixEvents(
  canonicalEvents: readonly SessionEvent[],
  childEvents: readonly SessionEvent[]
): SessionEvent[] | null {
  const canonicalItems = projectNativeConversationItems(canonicalEvents);
  const childItems = projectNativeConversationItems(childEvents);
  if (
    !nativeConversationItemsAreProviderPortablePrefix(
      canonicalItems,
      childItems
    )
  ) {
    return null;
  }
  const suffixSourceIds = new Set(
    childItems.slice(canonicalItems.length).map(sourceEventIdOfNativeItem)
  );
  if (suffixSourceIds.size === 0) return [];
  return childEvents.filter((event) =>
    suffixSourceIds.has(nativeSourceEventId(event))
  );
}

function isContextCompactEvent(event: SessionEvent): boolean {
  return (
    event.actionType === "context_compacted" ||
    event.functionName === "context_compacted"
  );
}

function nativeCompactedSuffixEvents(
  canonicalEvents: readonly SessionEvent[],
  childEvents: readonly SessionEvent[]
): SessionEvent[] | null {
  const canonicalItems = projectNativeConversationItems(canonicalEvents);
  for (
    let compactIndex = 0;
    compactIndex < childEvents.length;
    compactIndex += 1
  ) {
    if (!isContextCompactEvent(childEvents[compactIndex])) continue;
    const beforeCompactItems = projectNativeConversationItems(
      childEvents.slice(0, compactIndex)
    );
    if (
      !nativeConversationItemsAreProviderPortablePrefix(
        canonicalItems,
        beforeCompactItems
      )
    ) {
      continue;
    }
    const preCompactSuffixIds = new Set(
      beforeCompactItems
        .slice(canonicalItems.length)
        .map(sourceEventIdOfNativeItem)
    );
    return childEvents.filter(
      (event, eventIndex) =>
        (eventIndex < compactIndex &&
          preCompactSuffixIds.has(nativeSourceEventId(event))) ||
        (eventIndex >= compactIndex &&
          nativeConversationEventSemanticKey(event) !== null)
    );
  }
  return null;
}

/**
 * Fold local execution episodes into one provider-portable conversation.
 *
 * Every child is a native materialization of the prefix accumulated before it.
 * Prefer the provider's effective native-item prefix (which understands an
 * existing compact marker). When a child performs another native compact,
 * verify the effective message list immediately before that marker, then append
 * the completed pre-compact turn, compact marker, and structured suffix.
 * Divergent/branched children never enter the canonical timeline.
 */
export function mergeVerifiedLocalExecutionTimeline(
  rootEvents: readonly SessionEvent[],
  segments: readonly LocalExecutionSegment[]
): SessionEvent[] {
  let canonical = [...rootEvents];
  // A reused child keeps materialized copies of turns that another child
  // executed later, and a provider may stamp those copies with its injection
  // time. Folding children in creation order would take such a copy before
  // the executing child's original rows and misplace the turn. Fold from
  // whichever child's next verified suffix starts earliest; a run stops as
  // soon as another child's next row is due, and the copy then verifies as
  // an already-folded prefix instead of appending a second time.
  for (;;) {
    const candidates = segments.flatMap(({ events }, index) => {
      const portable = verifiedNativeConversationSuffixEvents(
        canonical,
        events
      );
      if (portable) {
        return portable.length > 0
          ? [{ index, suffix: portable, splittable: true }]
          : [];
      }
      const compacted = nativeCompactedSuffixEvents(canonical, events);
      return compacted && compacted.length > 0
        ? [{ index, suffix: compacted, splittable: false }]
        : [];
    });
    if (candidates.length === 0) return canonical;
    const startsAt = (candidate: (typeof candidates)[number]) =>
      eventTimestampMs(candidate.suffix[0]);
    const chosen = candidates.reduce((best, candidate) =>
      startsAt(candidate) < startsAt(best) ? candidate : best
    );
    const cutoff = Math.min(
      ...candidates.filter((candidate) => candidate !== chosen).map(startsAt)
    );
    const run: SessionEvent[] = [];
    for (const event of chosen.suffix) {
      if (
        chosen.splittable &&
        run.length > 0 &&
        eventTimestampMs(event) > cutoff
      ) {
        break;
      }
      run.push(event);
    }
    canonical = [...canonical, ...run];
  }
}

function eventTimestampMs(event: SessionEvent): number {
  const parsed = Date.parse(event.createdAt ?? "");
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

/** One durable loader shared by local/imported execution and the visible UI. */
export async function loadLocalCanonicalConversationSnapshot(
  root: ConversationRootLocator
): Promise<LocalCanonicalConversationSnapshot> {
  const [{ events: rootEvents }, initialState] = await Promise.all([
    loadCanonicalConversationEvents(root.conversationId),
    loadLocalExecutionChildrenState(root),
  ]);
  const segments = await Promise.all(
    initialState.children.map(async (child) => {
      const events = await loadLocalExecutionChildEvents(child.session_id);
      const revisionAfterRead = await loadLocalExecutionChildNativeRevision(
        child.session_id
      );
      const revisionBeforeRead = initialState.nativeRevisions.get(
        child.session_id
      );
      return {
        child,
        events,
        nativeRevision:
          revisionBeforeRead === revisionAfterRead ? revisionAfterRead : null,
      };
    })
  );
  const revisionAtRead = localExecutionChildrenRevision(
    initialState.children,
    new Map(
      segments.map((segment) => [
        segment.child.session_id,
        segment.nativeRevision,
      ])
    )
  );
  const revisionAfterRead = await loadLocalExecutionChildrenRevision(root);
  return {
    events: mergeVerifiedLocalExecutionTimeline(rootEvents, segments),
    rootEvents,
    segments,
    childRevision:
      revisionAtRead !== null && revisionAtRead === revisionAfterRead
        ? revisionAtRead
        : null,
  };
}

/** One durable loader shared by local/imported execution and cloud replay. */
export async function loadLocalCanonicalConversationTimeline(
  root: ConversationRootLocator
): Promise<SessionEvent[]> {
  for (
    let attempt = 0;
    attempt < STABLE_CANONICAL_SNAPSHOT_ATTEMPTS;
    attempt += 1
  ) {
    const snapshot = await loadLocalCanonicalConversationSnapshot(root);
    if (snapshot.childRevision !== null) return snapshot.events;
  }
  throw new QueuedConversationRecoveryPendingError(
    "provider-native conversation changed while its canonical timeline was being read"
  );
}

/** Namespace only the verified child suffix for rendering on the root stream. */
export function projectVerifiedLocalExecutionTail(
  rootEvents: readonly SessionEvent[],
  segments: readonly LocalExecutionSegment[],
  canonicalSessionId: string
): SessionEvent[] {
  // Queue-owned rows make a user submission visible on the root immediately,
  // but they are not part of that root provider's native transcript. A reused
  // child can already contain earlier execution turns before the newest
  // optimistic row, so treating the row as a native-root item makes the real
  // child look divergent (root + newest user vs root + prior turns + newest
  // user) and rejects its entire suffix. Verify from the provider-native root;
  // `suppressLandedQueuedUserRows` replaces each matching optimistic bubble
  // with the landed child user row after projection.
  const nativeRootEvents = rootEvents.filter(
    (event) => !isOptimisticQueueUserEventId(event.id)
  );
  return collapseRetriedPromptCopies(
    mergeVerifiedLocalExecutionTimeline(nativeRootEvents, segments).slice(
      nativeRootEvents.length
    )
  ).map((event) => ({
    ...event,
    id: `${LOCAL_EXECUTION_TAIL_EVENT_PREFIX}${event.id}`,
    chunk_id: `${LOCAL_EXECUTION_TAIL_EVENT_PREFIX}${event.id}`,
    sessionId: canonicalSessionId,
  }));
}

/**
 * A provider records the prompt before it can reject the turn, and every
 * retry records it again, so a turn that was answered on its third attempt
 * leaves two identical, unanswered user rows directly ahead of the answered
 * one in the provider's transcript. They are the same message retried, not
 * three messages: keep only the last copy of a run of identical prompts that
 * nothing answered in between.
 */
export function collapseRetriedPromptCopies(
  tail: readonly SessionEvent[]
): SessionEvent[] {
  const kept: SessionEvent[] = [];
  for (const event of tail) {
    const previous = kept[kept.length - 1];
    if (
      previous &&
      previous.source === "user" &&
      event.source === "user" &&
      (previous.displayText ?? "").trim() !== "" &&
      (previous.displayText ?? "").trim() === (event.displayText ?? "").trim()
    ) {
      kept[kept.length - 1] = event;
      continue;
    }
    kept.push(event);
  }
  return kept;
}

function isFailedOptimisticQueueUserRow(event: SessionEvent): boolean {
  return (
    event.source === "user" &&
    isOptimisticQueueUserEventId(event.id) &&
    event.result?.["deliveryStatus"] === "failed"
  );
}

/**
 * A provider records the user's prompt before it can reject the turn, so the
 * child's landed copy of that prompt exists even when the turn failed. The
 * failed optimistic row is the visible retry owner: keep it and drop the
 * landed copy, otherwise the failure and its retry vanish behind a plain
 * duplicate bubble.
 */
export function suppressLandedRowsOfFailedQueuedTurns(
  anchorEvents: readonly SessionEvent[],
  tails: readonly SessionEvent[]
): SessionEvent[] {
  const failed = anchorEvents.filter(isFailedOptimisticQueueUserRow);
  if (failed.length === 0 || tails.length === 0) return [...tails];
  const failedIntents = new Set(
    failed
      .map((event) => turnIntentIdOf(event))
      .filter((id): id is string => Boolean(id))
  );
  // Every retry of a failed row records the prompt again in the child, so
  // all landed copies from the row's own lifetime onward belong to it; an
  // identical prompt from an earlier answered turn keeps its landed row.
  const failedByText = new Map<string, number>();
  for (const event of failed) {
    const text = (event.displayText ?? "").trim();
    if (!text) continue;
    const startedAt = Date.parse(event.createdAt ?? "");
    const current = failedByText.get(text);
    failedByText.set(
      text,
      current === undefined
        ? startedAt
        : Math.min(current, Number.isFinite(startedAt) ? startedAt : current)
    );
  }
  return tails.filter((landed) => {
    if (landed.source !== "user") return true;
    const turnIntentId = turnIntentIdOf(landed);
    if (turnIntentId) return !failedIntents.has(turnIntentId);
    const text = (landed.displayText ?? "").trim();
    const startedAt = text ? failedByText.get(text) : undefined;
    if (startedAt === undefined) return true;
    const landedAt = Date.parse(landed.createdAt ?? "");
    return (
      Number.isFinite(startedAt) &&
      Number.isFinite(landedAt) &&
      landedAt < startedAt
    );
  });
}

export function suppressLandedQueuedUserRows(
  anchorEvents: readonly SessionEvent[],
  tails: readonly SessionEvent[]
): SessionEvent[] {
  if (tails.length === 0) return [...anchorEvents];
  const optimistic = anchorEvents.filter(
    (event) =>
      event.source === "user" &&
      isOptimisticQueueUserEventId(event.id) &&
      !isFailedOptimisticQueueUserRow(event)
  );
  if (optimistic.length === 0) return [...anchorEvents];

  const suppressedIds = new Set<string>();
  for (const landed of tails) {
    if (landed.source !== "user") continue;
    const turnIntentId = turnIntentIdOf(landed);
    let matched = turnIntentId
      ? optimistic.find(
          (candidate) =>
            !suppressedIds.has(candidate.id) &&
            turnIntentIdOf(candidate) === turnIntentId
        )
      : undefined;
    if (!matched) {
      const landedText = (landed.displayText ?? "").trim();
      if (!landedText) continue;
      const landedAt = Date.parse(landed.createdAt ?? "");
      const candidates = optimistic.filter(
        (candidate) =>
          !suppressedIds.has(candidate.id) &&
          (candidate.displayText ?? "").trim() === landedText
      );
      matched = candidates
        .filter((candidate) => {
          const candidateAt = Date.parse(candidate.createdAt ?? "");
          return (
            !Number.isFinite(landedAt) ||
            !Number.isFinite(candidateAt) ||
            candidateAt <= landedAt
          );
        })
        .at(-1);
    }
    if (matched) suppressedIds.add(matched.id);
  }
  return anchorEvents.filter((event) => !suppressedIds.has(event.id));
}

export async function loadLocalExecutionChildEvents(
  sessionId: string
): Promise<SessionEvent[]> {
  const { events } = await loadCanonicalConversationEvents(sessionId);
  return [...events];
}
