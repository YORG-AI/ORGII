/**
 * Conversation turn runner — the write half of the 0024 conversation-events
 * plane (design: docs/conversation-events-plane-design-2026-08-21.md).
 *
 * When a member chats in a conversation they do not own, the turn executes
 * in a LOCAL, invisible continuation session on their machine
 * (sender-runs / sender-pays) and the resulting events are pushed —
 * author-stamped — to the shared plane. No fork, no transcript copy, no new
 * sidebar entity.
 *
 * The first turn prepares an idle local runner and dispatches through the
 * canonical turn boundary. Later turns reuse that same session and inject
 * only the plane delta after its monotonic read cursor. A failed episode or
 * assigned-agent or desired runtime change rolls to a fresh runner.
 *
 * Push order is Slack-shaped: the user's message row goes out FIRST (every
 * client sees it instantly), the agent tail follows under the same turnId
 * when the local run completes.
 */
import Message from "@src/components/Message";
import type { TurnTerminalStatus } from "@src/engines/SessionCore/control/turnLifecycle";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { SessionService } from "@src/engines/SessionCore/services/SessionService";
import {
  reserveTurnDispatch,
  sendReservedTurn,
  waitForTurnOutcome,
} from "@src/engines/SessionCore/services/TurnDispatchService";
import { mintTurnIntentId } from "@src/engines/SessionCore/sync/adapters/shared/eventFactories";
import { loadAuthoritativeSessionEvents } from "@src/engines/SessionCore/sync/authoritativeSessionEvents";
import type { ForkSessionSetupSelection } from "@src/features/TeamCollaboration/components/ForkSessionSetupDialog";
import { requestForkSessionSetup } from "@src/features/TeamCollaboration/forkSession";
import {
  clearForkSetupMemory,
  loadForkSetupMemory,
  saveForkSetupMemory,
} from "@src/features/TeamCollaboration/forkSetupMemory";
import { createLogger } from "@src/hooks/logger";
import i18n from "@src/i18n";

import {
  type CloudConversationEvent,
  type ConversationEventWindow,
  boundConversationEventForPush,
  pushConversationEvents,
  pushConversationEventsChunked,
} from "../org2CloudConversationEventsClient";
import {
  advanceContinuationReadThrough,
  decideContinuation,
  loadContinuation,
  markContinuationEstablished,
  prepareContinuation,
  retireContinuation,
} from "./conversationContinuation";
import {
  conversationSetupChangesRuntime,
  isRunnableConversationSetup,
} from "./conversationExecutionIdentity";
import {
  cleanupConversationRunnerBestEffort,
  cleanupRetiredConversationRunners,
  conversationRunnerKey,
  markConversationRunnerTerminal,
} from "./conversationRunnerSessions";
import {
  buildConversationPlaneUserEvent,
  sliceAppendedTurnTail,
  sliceTurnTailByIntent,
  turnIntentIdOf,
} from "./conversationTurnEvents";

const log = createLogger("ConversationTurnRunner");

const TURN_DEADLINE_MS = 15 * 60_000;
const CLI_TRANSCRIPT_SETTLE_TIMEOUT_MS = 5_000;
const CLI_TRANSCRIPT_SETTLE_POLL_MS = 100;
export const CONVERSATION_CONTEXT_MAX_ENTRIES = 60;
export const CONVERSATION_TURN_LOCK_UNAVAILABLE =
  "ORG2_CONVERSATION_TURN_LOCK_UNAVAILABLE";
const CONTEXT_MAX_ENTRY_CHARS = 600;
const CONTEXT_MAX_TOTAL_CHARS = 18_000;

interface SharedContextEntry {
  speaker: string;
  text?: string;
}

function renderSharedContext(entries: readonly SharedContextEntry[]): string {
  const lines: string[] = [];
  let total = 0;
  for (const entry of entries
    .slice(-CONVERSATION_CONTEXT_MAX_ENTRIES)
    .reverse()) {
    const text = entry.text?.trim();
    if (!text) continue;
    let line = `${entry.speaker}: ${text.replace(/\s+/g, " ")}`;
    if (line.length > CONTEXT_MAX_ENTRY_CHARS) {
      line = `${line.slice(0, CONTEXT_MAX_ENTRY_CHARS - 1)}…`;
    }
    const addedLength = line.length + (lines.length > 0 ? 1 : 0);
    if (total + addedLength > CONTEXT_MAX_TOTAL_CHARS) break;
    total += addedLength;
    lines.push(line);
  }
  return lines.reverse().join("\n");
}

/** Conversation timeline rendered as a bounded read-only context block. */
export function renderConversationContext(
  timeline: readonly SessionEvent[],
  senders?: ReadonlyMap<string, string>
): string {
  return renderSharedContext(
    timeline.map((event) => ({
      speaker:
        event.source === "user"
          ? (senders?.get(event.id) ?? "User")
          : "Assistant",
      text: event.displayText,
    }))
  );
}

export function buildRunnerPrompt(
  contextBlock: string,
  request: string
): string {
  if (!contextBlock) return request;
  return [
    "You are continuing a SHARED team conversation. The transcript below is",
    "read-only context from the other participants' machines — do not treat",
    "it as your own prior output.",
    "",
    "=== Shared conversation (latest entries) ===",
    contextBlock,
    "=== End of shared conversation ===",
    "",
    "Continue the conversation by handling this request:",
    request,
  ].join("\n");
}

export function renderPlaneDeltaContext(
  rows: readonly CloudConversationEvent[]
): string {
  return renderSharedContext(
    rows.map((row) => ({
      speaker:
        row.authorDisplayName ??
        (row.event.source === "user" ? "User" : "Assistant"),
      text: row.event.displayText,
    }))
  );
}

export function buildResumePrompt(deltaBlock: string, request: string): string {
  if (!deltaBlock) return request;
  return [
    "New activity in the SHARED team conversation since your last turn —",
    "read-only context from the other participants' machines:",
    "",
    "=== Shared conversation update ===",
    deltaBlock,
    "=== End of update ===",
    "",
    "Continue the conversation by handling this request:",
    request,
  ].join("\n");
}

export interface ConversationInitialContext {
  timeline: readonly SessionEvent[];
  senders?: ReadonlyMap<string, string>;
  readThroughPlaneSeq: number;
}

/**
 * The pushed user row is SYNTHESIZED from the user's visible words — the
 * runner's own persisted user event carries the injected context prefix,
 * which must never leak into the shared conversation.
 */
export interface RunConversationTurnParams {
  /**
   * Resolved before EVERY push. A turn can outlive the access token that
   * was valid at dispatch (a 10-minute tool-heavy turn did, live), so the
   * tail push must never reuse a token captured at the start.
   */
  getAccessToken: () => Promise<string>;
  orgId: string;
  rootSessionId: string;
  conversationTitle: string;
  displayText: string;
  agentContent?: string;
  imageDataUrls?: string[];
  /** Loaded only when a fresh execution episode needs a full context seed. */
  loadInitialContext: (
    excludeTurnIntentId: string
  ) => Promise<ConversationInitialContext>;
  /** Plane rows after the continuation's exclusive read cursor. */
  loadPlaneDelta: (afterSeq: number) => Promise<ConversationEventWindow>;
  sourceScopeKey?: string;
  sourceModel?: string;
  assignedAgentDefinitionId?: string;
  setupMemoryKey?: string;
  /** Account-and-org-scoped local executor identity. */
  executionScopeKey: string;
  /** Stable logical id for durable redelivery; minted for ordinary chat. */
  turnIntentId?: string;
  /**
   * Durable redelivery fence. Once the backend has prepared a local runner,
   * the same run may only resume that exact Session after a restart.
   */
  requiredRunnerSessionId?: string;
  /**
   * A durable caller may bind this runner before transport send. In that
   * mode a send error must escape to the caller instead of silently rolling
   * to a different runner under the same fenced claim.
   */
  preserveRunnerOnTransportFailure?: boolean;
  /**
   * Called when the reusable runner and exact runtime intent are known.
   */
  onRunnerReady?: (
    runnerSessionId: string,
    turnId: string,
    turnIntentId: string
  ) => void | Promise<void>;
  /** Adapter accepted the exact intent; failures after this point are ambiguous. */
  onTransportAccepted?: (
    runnerSessionId: string,
    turnIntentId: string
  ) => void | Promise<void>;
  /** Called after the adapter accepts the exact runtime intent. */
  onTurnAccepted?: (
    runnerSessionId: string,
    turnIntentId: string
  ) => void | Promise<void>;
  /**
   * Fires after push #1 (the user's message row) lands on the plane — the
   * composer unblocks here; the agent tail streams in later under the same
   * turnId.
   */
  onUserMessagePublished?: () => void;
  /** Fires after each successful push (signal-bump hook). */
  onPushed?: () => void;
}

export interface RunConversationTurnResult {
  runnerSessionId: string;
  pushedEventCount: number;
  turnIntentId: string;
  terminalStatus: TurnTerminalStatus;
}

interface TurnPushIo {
  getAccessToken: () => Promise<string>;
  orgId: string;
  rootSessionId: string;
  turnId: string;
  turnIntentId: string;
  onPushed?: () => void;
}

async function dispatchRunnerTurn(
  params: RunConversationTurnParams,
  io: TurnPushIo,
  input: {
    runnerSessionId: string;
    content: string;
    accountId?: string;
    model?: string;
  }
): Promise<ReturnType<typeof reserveTurnDispatch>> {
  const dispatch = reserveTurnDispatch({
    sessionId: input.runnerSessionId,
    turnIntentId: io.turnIntentId,
    optimisticSource: "dispatch",
  });
  await sendReservedTurn({
    dispatch,
    content: input.content,
    displayText: params.displayText,
    model: input.model,
    accountId: input.accountId,
    imageDataUrls: params.imageDataUrls,
    clientMessageId: `conversation-turn:${io.turnIntentId}`,
    turnIntentSource: "user_submit",
    directUserIntent: true,
  });
  return dispatch;
}

async function pushUserRow(
  io: TurnPushIo,
  displayText: string,
  dispatchIso: string
): Promise<number> {
  const pushed = await pushConversationEvents(await io.getAccessToken(), {
    orgId: io.orgId,
    rootSessionId: io.rootSessionId,
    turnId: io.turnId,
    events: [
      boundConversationEventForPush(
        buildConversationPlaneUserEvent({
          id: `convturn-user-${io.turnIntentId}`,
          displayText,
          createdAt: dispatchIso,
          turnIntentId: io.turnIntentId,
        })
      ),
    ],
  });
  io.onPushed?.();
  return pushed.lastSeq;
}

async function pushAgentTail(
  io: TurnPushIo,
  runnerSessionId: string,
  deadlineMs: number,
  eventsBefore?: readonly SessionEvent[]
): Promise<{ count: number; lastSeq?: number }> {
  const settleDeadline = eventsBefore
    ? Math.min(deadlineMs, Date.now() + CLI_TRANSCRIPT_SETTLE_TIMEOUT_MS)
    : Date.now();
  let sliced: SessionEvent[] | null = null;
  for (;;) {
    const { events } = await loadAuthoritativeSessionEvents(runnerSessionId);
    sliced =
      sliceTurnTailByIntent(events, io.turnIntentId) ??
      (eventsBefore ? sliceAppendedTurnTail(eventsBefore, events) : null);
    if (sliced && (sliced.length > 0 || !eventsBefore)) break;
    if (!eventsBefore || Date.now() >= settleDeadline) {
      throw new Error(
        eventsBefore
          ? `conversation turn ${io.turnIntentId} native transcript did not expose an agent tail`
          : `conversation turn ${io.turnIntentId} is missing its user anchor`
      );
    }
    await new Promise((resolve) =>
      setTimeout(resolve, CLI_TRANSCRIPT_SETTLE_POLL_MS)
    );
  }
  const tail = sliced.map(boundConversationEventForPush);
  if (tail.length === 0) return { count: 0 };
  const pushed = await pushConversationEventsChunked(
    await io.getAccessToken(),
    {
      orgId: io.orgId,
      rootSessionId: io.rootSessionId,
      turnId: io.turnId,
      events: tail,
    }
  );
  io.onPushed?.();
  return { count: tail.length, lastSeq: pushed.lastSeq };
}

function collectLocalTurnIntentIds(
  events: readonly SessionEvent[]
): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    const turnIntentId = turnIntentIdOf(event);
    if (turnIntentId) ids.add(turnIntentId);
  }
  return ids;
}

function assertAssignedAgent(
  selectedAgentDefinitionId: string,
  params: RunConversationTurnParams
): void {
  if (
    params.assignedAgentDefinitionId &&
    params.assignedAgentDefinitionId !== selectedAgentDefinitionId
  ) {
    throw new Error(
      `conversation requires agent ${params.assignedAgentDefinitionId}; ` +
        `selected ${selectedAgentDefinitionId}`
    );
  }
}

const localTurnQueues = new Map<string, Promise<unknown>>();

async function withLocalTurnQueue<T>(
  key: string,
  run: () => Promise<T>
): Promise<T> {
  const previous = localTurnQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  localTurnQueues.set(key, next);
  try {
    return await next;
  } finally {
    if (localTurnQueues.get(key) === next) localTurnQueues.delete(key);
  }
}

/** Serialize one continuation across windows; Node tests use the local queue. */
export async function withConversationTurnLock<T>(
  key: string,
  run: () => Promise<T>
): Promise<T> {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (locks) {
    return locks.request(
      `orgii:conversation-turn:${key}`,
      { mode: "exclusive" },
      run
    );
  }
  if (typeof window !== "undefined") {
    throw new Error(CONVERSATION_TURN_LOCK_UNAVAILABLE);
  }
  return withLocalTurnQueue(key, run);
}

export async function runConversationTurn(
  params: RunConversationTurnParams
): Promise<RunConversationTurnResult> {
  const key = conversationRunnerKey(
    params.executionScopeKey,
    params.rootSessionId
  );
  return withConversationTurnLock(key, () =>
    runConversationTurnSerialized(params)
  );
}

async function runConversationTurnSerialized(
  params: RunConversationTurnParams
): Promise<RunConversationTurnResult> {
  const key = conversationRunnerKey(
    params.executionScopeKey,
    params.rootSessionId
  );
  const request = params.agentContent ?? params.displayText;
  const deadlineMs = Date.now() + TURN_DEADLINE_MS;
  const dispatchIso = new Date().toISOString();
  const turnIntentId = params.turnIntentId ?? mintTurnIntentId();
  const io: TurnPushIo = {
    getAccessToken: params.getAccessToken,
    orgId: params.orgId,
    rootSessionId: params.rootSessionId,
    turnId: turnIntentId,
    turnIntentId,
    onPushed: params.onPushed,
  };
  const record = loadContinuation(
    params.executionScopeKey,
    params.rootSessionId
  );
  const configuredSetup = loadForkSetupMemory(
    params.setupMemoryKey ?? params.sourceScopeKey
  );
  if (
    params.requiredRunnerSessionId &&
    record?.continuationSessionId !== params.requiredRunnerSessionId
  ) {
    throw new Error(
      `conversation turn ${turnIntentId} requires prepared runner ` +
        `${params.requiredRunnerSessionId}; local continuation is ` +
        `${record?.continuationSessionId ?? "missing"}`
    );
  }
  const decision = decideContinuation({
    record,
    turnIntentId,
    assignedAgentDefinitionId: params.assignedAgentDefinitionId,
    runtimeSetupChanged: Boolean(
      record &&
      isRunnableConversationSetup(configuredSetup) &&
      conversationSetupChangesRuntime(record, configuredSetup)
    ),
  });
  if (params.requiredRunnerSessionId && decision.kind === "fresh") {
    throw new Error(
      `prepared runner ${params.requiredRunnerSessionId} is incompatible: ` +
        `${decision.rollReason ?? "continuation unavailable"}`
    );
  }
  if (decision.kind === "fresh" && decision.rollReason) {
    log.info(`rolling conversation continuation: ${decision.rollReason}`);
    retireContinuation(
      params.executionScopeKey,
      params.rootSessionId,
      decision.rollReason
    );
    if (record) {
      await cleanupConversationRunnerBestEffort(record.continuationSessionId);
    }
  }
  if (decision.kind === "resume") {
    const persistedBefore = (
      await loadAuthoritativeSessionEvents(
        decision.record.continuationSessionId
      )
    ).events;
    const delta = await params.loadPlaneDelta(
      decision.record.readThroughPlaneSeq
    );
    const localIntentIds = collectLocalTurnIntentIds(persistedBefore);
    const contextRows = delta.events.filter(
      (row) => !localIntentIds.has(row.turnId)
    );
    await params.onRunnerReady?.(
      decision.record.continuationSessionId,
      turnIntentId,
      turnIntentId
    );
    const userRowLastSeq = await pushUserRow(
      io,
      params.displayText,
      dispatchIso
    );
    params.onUserMessagePublished?.();

    let dispatch;
    try {
      dispatch = await dispatchRunnerTurn(params, io, {
        runnerSessionId: decision.record.continuationSessionId,
        content: buildResumePrompt(
          renderPlaneDeltaContext(contextRows),
          request
        ),
        model: decision.record.model,
        accountId: decision.record.accountId,
      });
    } catch (error) {
      if (params.preserveRunnerOnTransportFailure) throw error;
      log.warn("continuation send rejected; rolling to a fresh runner", error);
      retireContinuation(
        params.executionScopeKey,
        params.rootSessionId,
        "resume_transport_rejected",
        true
      );
      await cleanupConversationRunnerBestEffort(
        decision.record.continuationSessionId
      );
      return startFreshEpisode(
        params,
        io,
        {
          request,
          deadlineMs,
          dispatchIso,
          userRowLastSeq,
        },
        undefined,
        configuredSetup
      );
    }
    await params.onTransportAccepted?.(
      decision.record.continuationSessionId,
      io.turnIntentId
    );
    await params.onTurnAccepted?.(
      decision.record.continuationSessionId,
      io.turnIntentId
    );
    return settleEpisode(params, io, {
      key,
      runnerSessionId: decision.record.continuationSessionId,
      deadlineMs,
      readThroughPlaneSeq: delta.lastSeq,
      userRowLastSeq,
      eventsBefore: decision.record.cliAgentType ? persistedBefore : undefined,
      dispatch,
    });
  }

  const initialContext = await params.loadInitialContext(turnIntentId);
  if (decision.kind === "bootstrap") {
    return dispatchBootstrapEpisode(
      params,
      io,
      {
        request,
        deadlineMs,
        dispatchIso,
      },
      {
        runnerSessionId: decision.record.continuationSessionId,
        cliAgentType: decision.record.cliAgentType,
        accountId: decision.record.accountId,
        model: decision.record.model,
      },
      initialContext
    );
  }
  return startFreshEpisode(
    params,
    io,
    {
      request,
      deadlineMs,
      dispatchIso,
    },
    initialContext,
    configuredSetup
  );
}

interface BootstrapTurn {
  request: string;
  deadlineMs: number;
  dispatchIso: string;
  /** Present when a rejected resume already published the idempotent row. */
  userRowLastSeq?: number;
}

interface BootstrapEpisode {
  runnerSessionId: string;
  cliAgentType?: string;
  accountId?: string;
  model?: string;
}

async function startFreshEpisode(
  params: RunConversationTurnParams,
  io: TurnPushIo,
  turn: BootstrapTurn,
  loadedContext?: ConversationInitialContext,
  configuredSetup?: ForkSessionSetupSelection | null
): Promise<RunConversationTurnResult> {
  const setupMemoryKey = params.setupMemoryKey ?? params.sourceScopeKey;
  const requestSetup = () =>
    requestForkSessionSetup({
      sourceTitle: params.conversationTitle,
      sourceScopeKey: params.sourceScopeKey,
      sourceModel: params.sourceModel,
      sourceAgentDefinitionId: params.assignedAgentDefinitionId,
      allowCliRuntime: true,
      lockSourceAgent: Boolean(params.assignedAgentDefinitionId),
    });
  const rememberedCandidate =
    configuredSetup === undefined
      ? loadForkSetupMemory(setupMemoryKey)
      : configuredSetup;
  const remembered = isRunnableConversationSetup(rememberedCandidate)
    ? rememberedCandidate
    : null;
  if (rememberedCandidate && !remembered) {
    clearForkSetupMemory(setupMemoryKey);
  }
  let usedRememberedSetup = Boolean(remembered);
  let setup = remembered ?? (await requestSetup());
  if (setup.execution.cliAgentType && !setup.execution.accountId) {
    throw new Error(
      "External CLI continuation requires an explicit local account"
    );
  }
  if (!remembered) saveForkSetupMemory(setupMemoryKey, setup);
  assertAssignedAgent(setup.execution.agentDefinitionId, params);
  const initialContext =
    loadedContext ?? (await params.loadInitialContext(io.turnIntentId));

  const createRunner = () =>
    SessionService.create({
      task: "",
      name: params.conversationTitle,
      repoPath: setup.workspaceRepoPath ?? undefined,
      model: setup.execution.model,
      accountId: setup.execution.accountId,
      cliAgentType: setup.execution.cliAgentType,
      keySource: "own_key",
      agentDefinitionId: setup.execution.agentDefinitionId,
      mode: "build",
    });
  let created;
  try {
    created = await createRunner();
  } catch (error) {
    if (!usedRememberedSetup) throw error;
    log.warn("remembered runner setup failed; re-prompting", error);
    clearForkSetupMemory(setupMemoryKey);
    setup = await requestSetup();
    if (setup.execution.cliAgentType && !setup.execution.accountId) {
      throw new Error(
        "External CLI continuation requires an explicit local account"
      );
    }
    assertAssignedAgent(setup.execution.agentDefinitionId, params);
    saveForkSetupMemory(setupMemoryKey, setup);
    usedRememberedSetup = false;
    created = await createRunner();
  }
  if (usedRememberedSetup) {
    Message.info(
      i18n.t("navigation:collaboration.session.forkSetupReused", {
        model:
          setup.execution.model ??
          setup.execution.cliAgentType ??
          setup.execution.agentDefinitionId,
      })
    );
  }

  const runnerSessionId = created.sessionId;
  try {
    prepareContinuation(
      params.executionScopeKey,
      params.rootSessionId,
      {
        continuationSessionId: runnerSessionId,
        readThroughPlaneSeq: 0,
        established: false,
        bootstrapTurnIntentId: io.turnIntentId,
        agentDefinitionId: setup.execution.agentDefinitionId,
        cliAgentType: setup.execution.cliAgentType,
        accountId: setup.execution.accountId,
        model: setup.execution.model,
        workspaceRepoPath: setup.workspaceRepoPath ?? null,
      },
      turn.dispatchIso
    );
  } catch (error) {
    await cleanupConversationRunnerBestEffort(runnerSessionId);
    throw error;
  }
  return dispatchBootstrapEpisode(
    params,
    io,
    turn,
    {
      runnerSessionId,
      cliAgentType: setup.execution.cliAgentType,
      accountId: setup.execution.accountId,
      model: setup.execution.model,
    },
    initialContext
  );
}

async function dispatchBootstrapEpisode(
  params: RunConversationTurnParams,
  io: TurnPushIo,
  turn: BootstrapTurn,
  episode: BootstrapEpisode,
  initialContext: ConversationInitialContext
): Promise<RunConversationTurnResult> {
  const key = conversationRunnerKey(
    params.executionScopeKey,
    params.rootSessionId
  );
  await params.onRunnerReady?.(
    episode.runnerSessionId,
    io.turnId,
    io.turnIntentId
  );
  let userRowLastSeq = turn.userRowLastSeq;
  if (userRowLastSeq === undefined) {
    userRowLastSeq = await pushUserRow(
      io,
      params.displayText,
      turn.dispatchIso
    );
    params.onUserMessagePublished?.();
  }
  const eventsBefore = episode.cliAgentType
    ? (await loadAuthoritativeSessionEvents(episode.runnerSessionId)).events
    : undefined;
  let dispatch;
  try {
    dispatch = await dispatchRunnerTurn(params, io, {
      runnerSessionId: episode.runnerSessionId,
      content: buildRunnerPrompt(
        renderConversationContext(
          initialContext.timeline,
          initialContext.senders
        ),
        turn.request
      ),
      model: episode.model,
      accountId: episode.accountId,
    });
  } catch (error) {
    if (!params.preserveRunnerOnTransportFailure) {
      retireContinuation(
        params.executionScopeKey,
        params.rootSessionId,
        "bootstrap_transport_rejected",
        true
      );
      await cleanupConversationRunnerBestEffort(episode.runnerSessionId);
    }
    throw error;
  }
  await params.onTransportAccepted?.(episode.runnerSessionId, io.turnIntentId);
  if (
    !markContinuationEstablished(
      params.executionScopeKey,
      params.rootSessionId,
      episode.runnerSessionId,
      io.turnIntentId
    )
  ) {
    throw new Error("continuation acceptance could not be persisted");
  }
  await params.onTurnAccepted?.(episode.runnerSessionId, io.turnIntentId);
  return settleEpisode(params, io, {
    key,
    runnerSessionId: episode.runnerSessionId,
    deadlineMs: turn.deadlineMs,
    readThroughPlaneSeq: initialContext.readThroughPlaneSeq,
    userRowLastSeq,
    eventsBefore,
    dispatch,
  });
}

async function settleEpisode(
  params: RunConversationTurnParams,
  io: TurnPushIo,
  input: {
    key: string;
    runnerSessionId: string;
    deadlineMs: number;
    readThroughPlaneSeq: number;
    userRowLastSeq: number;
    eventsBefore?: readonly SessionEvent[];
    dispatch: ReturnType<typeof reserveTurnDispatch>;
  }
): Promise<RunConversationTurnResult> {
  const outcome = await waitForTurnOutcome(input.dispatch, input.deadlineMs);
  markConversationRunnerTerminal(input.key, input.runnerSessionId);
  let tailCount = 0;
  try {
    const tail = await pushAgentTail(
      io,
      input.runnerSessionId,
      input.deadlineMs,
      input.eventsBefore
    );
    tailCount = tail.count;
    if (outcome.status === "completed") {
      advanceContinuationReadThrough(
        params.executionScopeKey,
        params.rootSessionId,
        Math.max(
          input.readThroughPlaneSeq,
          input.userRowLastSeq,
          tail.lastSeq ?? 0
        )
      );
    }
  } finally {
    if (outcome.status === "completed") {
      await cleanupRetiredConversationRunners(input.key, input.runnerSessionId);
    } else {
      retireContinuation(
        params.executionScopeKey,
        params.rootSessionId,
        `turn_${outcome.status}`,
        true
      );
      await cleanupConversationRunnerBestEffort(input.runnerSessionId);
    }
  }
  log.info(
    `published conversation turn ${io.turnId}: 1 + ${tailCount} event(s) ` +
      `to ${input.key} (${outcome.status})`
  );
  return {
    runnerSessionId: input.runnerSessionId,
    pushedEventCount: 1 + tailCount,
    turnIntentId: io.turnIntentId,
    terminalStatus: outcome.status,
  };
}
