/**
 * One in-place agent turn over unresolved cloud-comment threads.
 *
 * The turn is submitted through the exact same user-intent dispatcher as the
 * composer, so an active session queues it and an idle session sends it. The
 * agent must post thread replies through `session.replyComment`; transcript
 * text is never guessed or copied into a comment as a fallback.
 */
import { atom } from "jotai";

import {
  type TurnIntentDispatch,
  waitForTurnIntentDispatch,
} from "@src/engines/SessionCore/control/turnIntentDispatchLifecycle";
import {
  getLastTurnTerminal,
  turnLifecycleSignalAtom,
} from "@src/engines/SessionCore/control/turnLifecycle";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import { mintTurnIntentId } from "@src/engines/SessionCore/sync/adapters/shared/eventFactories";
import { getSessionForkedFrom } from "@src/features/TeamCollaboration/forkSession";
import { createLogger } from "@src/hooks/logger";
import { sessionByIdAtom } from "@src/store/session/sessionAtom";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import { stripCopyEventNamespace } from "../TeamCollaboration/copyEventId";
import {
  type AddressableThread,
  buildAddressCommentsBriefing,
  collectAddressableThreads,
} from "./addressComments";
import { commitRefreshedAuth, org2CloudAuthAtom } from "./org2CloudAuthAtom";
import { ensureFreshSession } from "./org2CloudClient";
import { broadcastCommentsChanged } from "./org2CloudCommentsBus";
import {
  addSessionComment,
  listSessionComments,
} from "./org2CloudCommentsClient";

const log = createLogger("addressCommentsRun");
const RUN_DEADLINE_MS = 15 * 60_000;

export interface AddressRunActivity {
  /** Null means the run targets every currently addressable thread. */
  selectedHeadIds: readonly string[] | null;
}

export const addressRunActiveAtom = atom<Record<string, AddressRunActivity>>(
  {}
);
addressRunActiveAtom.debugLabel = "addressRunActiveAtom";

export interface ActiveAddressRun {
  orgId: string;
  cloudSessionId: string;
  localSessionId: string;
  validHeadIds: ReadonlySet<string>;
  replied: Map<string, string>;
}

const activeAddressRuns = new Map<string, ActiveAddressRun>();
interface ScheduledAddressRun {
  token: symbol;
  selectedHeadIds: ReadonlySet<string> | null;
}

const scheduledRunsBySession = new Map<string, ScheduledAddressRun[]>();

function publishRunActivity(localSessionId: string): void {
  const runs = scheduledRunsBySession.get(localSessionId) ?? [];
  const selected = new Set<string>();
  for (const run of runs) {
    for (const headId of run.selectedHeadIds ?? []) selected.add(headId);
  }
  const selectedHeadIds = runs.some((run) => run.selectedHeadIds === null)
    ? null
    : [...selected];
  getInstrumentedStore().set(addressRunActiveAtom, (current) => {
    if (runs.length === 0) {
      if (!(localSessionId in current)) return current;
      const { [localSessionId]: _removed, ...rest } = current;
      return rest;
    }
    return { ...current, [localSessionId]: { selectedHeadIds } };
  });
}

function beginRunActivity(
  localSessionId: string,
  selectedHeadIds: readonly string[] | undefined
): () => void {
  const run: ScheduledAddressRun = {
    token: Symbol("address-comments-run"),
    selectedHeadIds:
      selectedHeadIds === undefined ? null : new Set(selectedHeadIds),
  };
  const current = scheduledRunsBySession.get(localSessionId) ?? [];
  scheduledRunsBySession.set(localSessionId, [...current, run]);
  publishRunActivity(localSessionId);
  return () => {
    const remaining = (scheduledRunsBySession.get(localSessionId) ?? []).filter(
      (candidate) => candidate.token !== run.token
    );
    if (remaining.length === 0) scheduledRunsBySession.delete(localSessionId);
    else scheduledRunsBySession.set(localSessionId, remaining);
    publishRunActivity(localSessionId);
  };
}

async function waitForTurnTerminal(
  dispatch: TurnIntentDispatch,
  deadlineMs: number
): Promise<void> {
  const { sessionId, generation } = dispatch;
  const isComplete = (): boolean =>
    getLastTurnTerminal(sessionId)?.generation === generation;
  if (isComplete()) return;
  const store = getInstrumentedStore();
  await new Promise<void>((resolve, reject) => {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      reject(new Error("address-comments run timed out"));
      return;
    }
    let unsubscribe: (() => void) | null = null;
    const timer = setTimeout(() => {
      unsubscribe?.();
      reject(new Error("address-comments run timed out"));
    }, remainingMs);
    const check = (): void => {
      if (!isComplete()) return;
      clearTimeout(timer);
      unsubscribe?.();
      resolve();
    };
    unsubscribe = store.sub(turnLifecycleSignalAtom, check);
    check();
  });
}

function findActiveAddressRunForComment(
  commentId: string,
  invokingSessionId: string
): ActiveAddressRun | undefined {
  if (invokingSessionId.length === 0) return undefined;
  const run = activeAddressRuns.get(invokingSessionId);
  return run?.validHeadIds.has(commentId) ? run : undefined;
}

export interface AddressReplyToolResult {
  success: boolean;
  message: string;
}

/** Trusted backend for the `session.replyComment` action. */
export async function replyViaActiveAddressRun(
  commentId: string,
  body: string,
  invokingSessionId?: string
): Promise<AddressReplyToolResult> {
  const trimmedBody = body.trim();
  if (trimmedBody.length === 0) {
    return { success: false, message: "Reply body must not be empty." };
  }
  if (typeof invokingSessionId !== "string" || invokingSessionId.length === 0) {
    return {
      success: false,
      message:
        "Reply rejected: no invoking session id. The reply tool must run inside an active address-comments turn.",
    };
  }
  const run = findActiveAddressRunForComment(commentId, invokingSessionId);
  if (!run) {
    return {
      success: false,
      message: `Unknown commentId "${commentId}". Only reply to comment ids listed in the current instructions, during the run that provided them.`,
    };
  }
  if (run.replied.has(commentId)) {
    return {
      success: false,
      message: `A reply was already posted to comment ${commentId} in this run. Do not reply to the same comment twice.`,
    };
  }
  const accessToken = await freshAccessToken();
  await addSessionComment(accessToken, {
    orgId: run.orgId,
    sessionId: run.cloudSessionId,
    body: trimmedBody,
    parentId: commentId,
    kind: "agent_report",
  });
  run.replied.set(commentId, trimmedBody);
  broadcastCommentsChanged(run.orgId, run.cloudSessionId);
  return { success: true, message: `Reply posted to comment ${commentId}.` };
}

type AddressRunFinishedListener = () => void;
const addressRunFinishedListeners = new Set<AddressRunFinishedListener>();

export function registerAddressRunFinishedListener(
  listener: AddressRunFinishedListener
): () => void {
  addressRunFinishedListeners.add(listener);
  return () => addressRunFinishedListeners.delete(listener);
}

function notifyAddressRunFinished(): void {
  for (const listener of [...addressRunFinishedListeners]) {
    try {
      listener();
    } catch (error) {
      log.warn(`address-run finished listener threw: ${String(error)}`);
    }
  }
}

export function isAddressRunActive(localSessionId: string): boolean {
  return (scheduledRunsBySession.get(localSessionId)?.length ?? 0) > 0;
}

async function freshAccessToken(): Promise<string> {
  const store = getInstrumentedStore();
  const current = store.get(org2CloudAuthAtom);
  if (!current) {
    throw new Error("org2 cloud sign-in required for an address-comments run");
  }
  const fresh = await ensureFreshSession(current);
  if (!fresh) throw new Error("org2 cloud session refresh failed");
  commitRefreshedAuth(
    (updater) => store.set(org2CloudAuthAtom, updater),
    current,
    fresh
  );
  return fresh.accessToken;
}

export interface AddressRoundEventLike {
  id: string;
  displayText?: string;
  source?: string;
}

export function attachAnchorExcerpts(
  threads: readonly AddressableThread[],
  events: readonly AddressRoundEventLike[],
  localSessionId?: string
): AddressableThread[] {
  const toSourceId = (id: string) =>
    localSessionId ? stripCopyEventNamespace(localSessionId, id) : id;
  const eventTextById = new Map<string, string>();
  const roundNumberByEventId = new Map<string, number>();
  const roundUserTextByNumber = new Map<number, string>();
  let roundNumber = 0;
  for (const event of events) {
    if (event.source === "user") {
      roundNumber += 1;
      if (event.displayText)
        roundUserTextByNumber.set(roundNumber, event.displayText);
    }
    if (roundNumber > 0)
      roundNumberByEventId.set(toSourceId(event.id), roundNumber);
    if (event.displayText)
      eventTextById.set(toSourceId(event.id), event.displayText);
  }
  return threads.map((thread) => {
    const eventId = thread.anchorEventId;
    if (!eventId) return thread;
    const anchorRoundNumber = roundNumberByEventId.get(eventId);
    const anchorExcerpt =
      (anchorRoundNumber !== undefined
        ? roundUserTextByNumber.get(anchorRoundNumber)
        : undefined) ?? eventTextById.get(eventId);
    if (anchorExcerpt === undefined) return thread;
    return {
      ...thread,
      anchorExcerpt,
      ...(anchorRoundNumber !== undefined ? { anchorRoundNumber } : {}),
    };
  });
}

export function seedActiveAddressRunForTest(run: ActiveAddressRun): () => void {
  activeAddressRuns.set(run.localSessionId, run);
  return () => {
    if (activeAddressRuns.get(run.localSessionId) === run) {
      activeAddressRuns.delete(run.localSessionId);
    }
  };
}

export interface AddressTurnSubmitInput {
  displayContent: string;
  agentContent: string;
  turnIntentId: string;
}

export type AddressTurnDispatcher = (
  input: AddressTurnSubmitInput
) => Promise<void>;

export interface AddressRoundInput {
  orgId: string;
  cloudSessionId: string;
  localSessionId: string;
  dispatchTurn: AddressTurnDispatcher;
  selectedHeadIds?: readonly string[];
  instruction?: string;
}

export type AddressRoundResult =
  | { status: "no_threads" }
  | { status: "ran"; threadCount: number; replyCount: number };

function buildDisplayContent(threads: readonly AddressableThread[]): string {
  if (threads.length === 1) {
    const body = threads[0].headBody.replace(/^\s*@agent\b\s*/i, "");
    return `@agent ${body}`.trim();
  }
  return `@agent Address ${threads.length} cloud comment threads`;
}

/**
 * Rounds are SERIALIZED per local session: `activeAddressRuns` holds one
 * registration per session, so a second round starting while one is in
 * flight would overwrite it and cross-validate the running turn's
 * `reply_session_comment` calls against the wrong head-id set (rejected as
 * unknown, or booked into the wrong run's replied map). Queued rounds also
 * list comments AFTER the prior round settles, so they see its replies and
 * resolutions instead of re-addressing them.
 */
const roundChainBySession = new Map<string, Promise<unknown>>();

export async function runAddressCommentsRound(
  input: AddressRoundInput
): Promise<AddressRoundResult> {
  const { localSessionId } = input;
  // Activity begins at ENQUEUE (the scheduled-runs map is a list precisely
  // so a queued round's threads show as addressing while a prior round runs).
  const finishRunActivity = beginRunActivity(
    localSessionId,
    input.selectedHeadIds
  );
  const prior = roundChainBySession.get(localSessionId) ?? Promise.resolve();
  const round = prior.then(() => executeAddressCommentsRound(input));
  // Park the settled chain — a failed round must never poison the next.
  const parked = round.then(
    () => undefined,
    () => undefined
  );
  roundChainBySession.set(localSessionId, parked);
  try {
    return await round;
  } finally {
    finishRunActivity();
    if (roundChainBySession.get(localSessionId) === parked) {
      roundChainBySession.delete(localSessionId);
    }
  }
}

async function executeAddressCommentsRound(
  input: AddressRoundInput
): Promise<AddressRoundResult> {
  const {
    orgId,
    cloudSessionId,
    localSessionId,
    dispatchTurn,
    selectedHeadIds,
    instruction,
  } = input;
  let run: ActiveAddressRun | null = null;
  try {
    const listToken = await freshAccessToken();
    const { comments, viewerOwnsSession } = await listSessionComments(
      listToken,
      orgId,
      cloudSessionId
    );
    // Defense in depth: the rendered affordance also uses this server-derived
    // bit, but the runner itself must never spend a model account for an
    // imported replay, an unrelated local session, or another member. A
    // verified owner fork may address its source threads.
    if (!viewerOwnsSession) {
      throw new Error("@agent is available only on the owner's source session");
    }
    if (localSessionId !== cloudSessionId) {
      const localSession = getInstrumentedStore().get(
        sessionByIdAtom(localSessionId)
      );
      const forkedFrom = getSessionForkedFrom(
        localSession ?? { session_id: localSessionId }
      );
      if (
        forkedFrom?.orgId !== orgId ||
        forkedFrom.sourceSessionId !== cloudSessionId
      ) {
        throw new Error(
          "@agent may use only a verified local fork of the owner's cloud source"
        );
      }
    }
    let threads = collectAddressableThreads(comments);
    if (selectedHeadIds !== undefined) {
      const selected = new Set(selectedHeadIds);
      threads = threads.filter((thread) => selected.has(thread.headId));
    }
    if (threads.length === 0) return { status: "no_threads" };
    const anchorEvents = await eventStoreProxy
      .getPersistedEvents(localSessionId)
      .catch(() => []);
    threads = attachAnchorExcerpts(threads, anchorEvents, localSessionId);

    const turnIntentId = mintTurnIntentId();
    const deadlineMs = Date.now() + RUN_DEADLINE_MS;
    // Register before dispatch. A fast tool call may arrive as soon as the
    // transport accepts the turn; registering after dispatch left a race in
    // which a legitimate reply_session_comment call was rejected.
    run = {
      orgId,
      cloudSessionId,
      localSessionId,
      validHeadIds: new Set(threads.map((thread) => thread.headId)),
      replied: new Map(),
    };
    activeAddressRuns.set(localSessionId, run);
    await dispatchTurn({
      displayContent: buildDisplayContent(threads),
      agentContent: buildAddressCommentsBriefing(threads, instruction),
      turnIntentId,
    });
    const dispatch = await waitForTurnIntentDispatch(turnIntentId, deadlineMs);
    if (dispatch.sessionId !== localSessionId) {
      throw new Error("address-comments turn dispatched to the wrong session");
    }

    await waitForTurnTerminal(dispatch, deadlineMs);
    log.info(
      `address round on ${localSessionId}: ${threads.length} thread(s), ${run.replied.size} agent repl(ies)`
    );
    return {
      status: "ran",
      threadCount: threads.length,
      replyCount: run.replied.size,
    };
  } finally {
    if (run && activeAddressRuns.get(localSessionId) === run) {
      activeAddressRuns.delete(localSessionId);
    }
    notifyAddressRunFinished();
  }
}
