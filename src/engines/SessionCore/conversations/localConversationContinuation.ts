/**
 * Provider-neutral local continuation for one canonical conversation.
 *
 * The canonical transcript can come from Cloud, an imported session, or a
 * normal local Session. Execution always happens on this device with the
 * caller's selected local runtime/account/workspace. A normal persisted
 * Session is the continuation record: `parentSessionId` groups its hidden
 * execution episodes under a deterministic conversation parent, so no
 * localStorage runner registry or parallel continuation database is needed.
 */
import { getSession as getAgentSession } from "@src/api/tauri/agent";
import { rpc } from "@src/api/tauri/rpc";
import {
  type TurnTerminalStatus,
  toTurnTerminalStatus,
} from "@src/engines/SessionCore/control/turnLifecycle";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { SessionService } from "@src/engines/SessionCore/services/SessionService";
import {
  type UserIntentPreparation,
  UserIntentSendError,
  activateUserIntentPreparation,
  adoptAcceptedUserIntent,
  confirmUserIntentPreparation,
  dispatchUserIntent,
  failUserIntentPreparation,
  isUserIntentSendError,
  prepareUserIntent,
  settleUserIntentLifecycle,
} from "@src/engines/SessionCore/services/userIntentDispatch";
import { loadAuthoritativeSessionEvents } from "@src/engines/SessionCore/sync/authoritativeSessionEvents";
import {
  reconcileNativeTranscript,
  recoverNativeTranscriptAfterMismatch,
} from "@src/engines/SessionCore/sync/nativeTranscriptReconcile";
import { turnIntentIdOf } from "@src/engines/SessionCore/sync/utils/activityIds";
import { createLogger } from "@src/hooks/logger";
import { invokeTauri } from "@src/util/platform/tauri/init";
import { isCliSession } from "@src/util/session/sessionDispatch";

import type {
  ConversationRootLocator,
  LocalConversationTarget,
} from "./conversationTypes";
import {
  materializeNativeConversation,
  nativeConversationItemsArePrefix,
  nativeConversationItemsAreProviderPortablePrefix,
  nativeSourceEventId,
  projectNativeConversationItems,
  removeKnownNativeConversationEchoes,
  sourceEventIdOfNativeItem,
  supportsNativeConversationTarget,
  synchronizeNativeConversation,
} from "./nativeConversationMaterializer";
import {
  QueuedConversationRecoveryBlockedError,
  QueuedConversationRecoveryPendingError,
} from "./queuedConversationContract";

export type {
  ConversationRootLocator,
  LocalConversationTarget,
} from "./conversationTypes";

const TURN_WAIT_WINDOW_MS = 60_000;
const log = createLogger("localConversationContinuation");

function isCodexNativeEpisodeAlreadyOwned(
  error: unknown,
  target: LocalConversationTarget
): boolean {
  if (target.cliAgentType !== "codex") return false;

  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current != null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      messages.push(current.message);
      current = (current as Error & { cause?: unknown }).cause;
      continue;
    }
    messages.push(String(current));
    break;
  }
  const message = messages.join("\n").toLowerCase();
  return (
    message.includes("-32600") &&
    message.includes("thread/resume") &&
    message.includes("already has an active writer")
  );
}

async function notifyConversationTurnAccepted(
  callback: ContinueLocalConversationParams["onTurnAccepted"],
  sessionId: string,
  turnIntentId: string
): Promise<void> {
  if (!callback) return;
  try {
    await callback(sessionId);
  } catch (error) {
    log.error(
      `[native-continuation] failed to persist acceptance receipt for ${turnIntentId}`,
      error
    );
    // Provider acceptance is already irreversible. The durable queue must
    // retain this exact owner and reconnect by turnIntentId; continuing as if
    // bookkeeping succeeded would silently strand a running native turn and
    // make a later retry eligible to send twice.
    throw new QueuedConversationRecoveryPendingError(
      `provider accepted ${turnIntentId}, but its durable receipt could not be persisted: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export const CONVERSATION_TURN_ID_ARG = "conversationTurnId";

interface ContinueLocalConversationParams {
  root: ConversationRootLocator;
  title: string;
  /** Canonical transcript immediately before this new user turn. */
  timeline: readonly SessionEvent[];
  displayText: string;
  agentContent?: string;
  imageDataUrls?: string[];
  target: LocalConversationTarget;
  turnIntentId: string;
  onSessionReady?: (
    sessionId: string,
    /** Authoritative native-event prefix that predates this turn. */
    eventStartIndex: number
  ) => void | Promise<void>;
  /**
   * Last reversible boundary before the selected provider receives the turn.
   * Cloud authority uses it to durably mark a cross-device lease accepted;
   * recovery also invokes it when an older local receipt proves the provider
   * already crossed that boundary. Local conversations leave it unset.
   */
  onBeforeTurnDispatch?: (sessionId: string) => void | Promise<void>;
  /**
   * Fires once the selected provider has durably accepted this user turn.
   * Queue ownership lives above the continuation adapter: callers use this
   * boundary to remove the durable queue row while the native turn keeps
   * running and reconciling in the background.
   */
  onTurnAccepted?: (sessionId: string) => void | Promise<void>;
  /**
   * A fresh episode now owns preparation, before its canonical transcript has
   * finished materializing. Surfaces use this to bind the ordinary planning
   * footer immediately without overlaying historical events.
   */
  onSessionPreparing?: (sessionId: string) => void | Promise<void>;
}

interface ContinueLocalConversationAfterTimelineLoadParams extends Omit<
  ContinueLocalConversationParams,
  "timeline"
> {
  /**
   * Read the authoritative canonical transcript only after this conversation
   * reaches the head of the singleton message queue. This prevents a submit made
   * immediately after Stop from racing the previous turn's native-tail
   * reconciliation and materializing a stale prefix into the next runtime.
   */
  loadTimeline: () => Promise<readonly SessionEvent[]>;
}

export interface ContinueLocalConversationResult {
  sessionId: string;
  terminalStatus: TurnTerminalStatus;
  agentTail: SessionEvent[];
}

interface RecoverLocalConversationParams extends ContinueLocalConversationParams {
  runnerSessionId: string;
  eventStartIndex?: number;
}

type ConversationTurnPreparation = UserIntentPreparation;

interface ChildSessionView {
  sessionId: string;
  updatedAt: string;
}

interface ExecutionCandidate {
  sessionId: string;
  updatedAt: string;
}

/**
 * Read-only execution identity persisted by the normal Session owner.
 *
 * This is intentionally only a projection of existing Session rows. It is
 * not another continuation registry: callers use it to hydrate picker state
 * after restart, while execution and resume continue to use those same rows.
 */
export interface LocalConversationExecutionTargetSnapshot {
  sessionId: string;
  updatedAt: string;
  target: LocalConversationTarget;
}

function requireIdentityPart(label: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`conversation ${label} is required`);
  if (normalized.length > 2_048) {
    throw new Error(`conversation ${label} is too long`);
  }
  return normalized;
}

/** Durable grouping id stored directly on normal native/CLI Session rows. */
export function conversationExecutionParentId(
  locator: ConversationRootLocator
): string {
  if (locator.authorityScope.length > 16) {
    throw new Error("conversation authority scope has too many parts");
  }
  return JSON.stringify([
    "org2-conversation",
    1,
    requireIdentityPart("authority", locator.authority),
    locator.authorityScope.map((part, index) =>
      requireIdentityPart(`authority scope ${index}`, part)
    ),
    requireIdentityPart("id", locator.conversationId),
  ]);
}

/** Parse only parent ids emitted by `conversationExecutionParentId`. */
export function parseConversationExecutionParentId(
  value: string | null | undefined
): ConversationRootLocator | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 5 ||
      parsed[0] !== "org2-conversation" ||
      parsed[1] !== 1 ||
      typeof parsed[2] !== "string" ||
      !Array.isArray(parsed[3]) ||
      !parsed[3].every((part) => typeof part === "string") ||
      typeof parsed[4] !== "string"
    ) {
      return null;
    }
    return {
      authority: parsed[2],
      authorityScope: parsed[3] as string[],
      conversationId: parsed[4],
    };
  } catch {
    return null;
  }
}

/**
 * Promote a normal readable My Session to a canonical conversation root.
 * Target support is checked separately: any native transcript may be a source,
 * while only runtimes with a verified writer/reader adapter may execute it.
 */
export function localConversationRootForSession(
  sessionId: string,
  _cliAgentType: string | null | undefined,
  agentDefinitionId?: string | null
): ConversationRootLocator | null {
  // The session-id namespace already proves that this is a readable native
  // CLI conversation. Sidebar/lightweight rows can hydrate before their
  // `cliAgentType`; requiring that presentation metadata here made the
  // continuation binding disappear and left only the unrelated global model
  // picker. Target resolution remains strict and asks the user to choose a
  // runtime until the missing metadata arrives.
  if (!isCliSession(sessionId) && !agentDefinitionId) {
    return null;
  }
  return {
    authority: "local-session",
    authorityScope: [],
    conversationId: sessionId,
  };
}

export function conversationTurnIdOf(event: SessionEvent): string | null {
  const turnIntentId = turnIntentIdOf(event);
  if (turnIntentId) return turnIntentId;
  const value = event.args?.[CONVERSATION_TURN_ID_ARG];
  return typeof value === "string" && value.length > 0 ? value : null;
}

async function listExecutionChildren(
  parentSessionId: string
): Promise<ExecutionCandidate[]> {
  const children = await invokeTauri<ChildSessionView[]>(
    "es_get_child_sessions",
    { parentSessionId }
  );
  return children
    .filter(
      (child) =>
        typeof child.sessionId === "string" && child.sessionId.length > 0
    )
    .map((child) => ({
      sessionId: child.sessionId,
      updatedAt: child.updatedAt,
    }))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

async function listExecutionCandidates(
  locator: ConversationRootLocator
): Promise<ExecutionCandidate[]> {
  const children = await listExecutionChildren(
    conversationExecutionParentId(locator)
  );
  if (locator.authority !== "local-session") return children;

  // The ordinary source Session is already a fully native execution episode.
  // Include it next to provider-switch children so returning to the source
  // provider reuses its native UUID instead of creating a duplicate copy.
  let root: ExecutionRow | null;
  try {
    root = await readExecutionRow(locator.conversationId);
  } catch (error) {
    throw new QueuedConversationRecoveryPendingError(
      `source execution identity is temporarily unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (!root?.updatedAt) return children;
  return [
    {
      sessionId: locator.conversationId,
      updatedAt: root.updatedAt,
    },
    ...children,
  ].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function sameOptional(left: unknown, right: string | undefined): boolean {
  return (
    (typeof left === "string" && left.length > 0 ? left : undefined) === right
  );
}

function comparableWorkspacePath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let normalized = value
    .trim()
    .replace(/^file:\/\//, "")
    .replace(/\/+$/, "");
  if (!normalized) return undefined;
  // macOS exposes the same temporary filesystem through both spellings.
  // Agent session rows are canonicalized by Rust to /private/tmp while the
  // New Session/workspace picker can retain the user-facing /tmp spelling.
  // Treating that alias as a runtime identity change creates an unnecessary
  // child episode and moves the live answer off the visible owner stream.
  if (normalized === "/private/tmp") normalized = "/tmp";
  else if (normalized.startsWith("/private/tmp/")) {
    normalized = normalized.slice("/private".length);
  }
  return normalized;
}

function sameWorkspacePath(left: unknown, right: string | undefined): boolean {
  const requested = comparableWorkspacePath(right);
  // A missing target path is the automatic-workspace state used while a
  // shared/imported Session hydrates its local repo-scope match. For an
  // existing native episode, its durable repo path is already the verified
  // local choice and must be inherited. A concrete different path remains an
  // intentional isolation boundary and rolls to a new episode.
  return requested === undefined || comparableWorkspacePath(left) === requested;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

interface ExecutionRow {
  target: LocalConversationTarget;
  updatedAt?: string;
}

async function readExecutionRow(
  sessionId: string
): Promise<ExecutionRow | null> {
  if (isCliSession(sessionId)) {
    const row = (await rpc.cli.status({ sessionId })) as Record<
      string,
      unknown
    > | null;
    if (!row) return null;
    const cliAgentType = optionalString(row.cliAgentType);
    const accountId = optionalString(row.accountId);
    const updatedAt = optionalString(row.updatedAt);
    if (!cliAgentType || (!accountId && cliAgentType !== "claude_code")) {
      return null;
    }
    return {
      target: {
        cliAgentType,
        accountId,
        model: optionalString(row.model),
        workspaceRepoPath:
          optionalString(row.worktreePath) ?? optionalString(row.repoPath),
      },
      updatedAt,
    };
  }

  const row = await getAgentSession(sessionId);
  if (!row) return null;
  const agentDefinitionId = optionalString(row.agentDefinitionId);
  const accountId = optionalString(row.accountId);
  const model = optionalString(row.model);
  const updatedAt = optionalString(row.updatedAt);
  if (!agentDefinitionId || !accountId || !model) return null;
  return {
    target: {
      agentDefinitionId,
      accountId,
      model,
      workspaceRepoPath: optionalString(row.workspacePath),
    },
    updatedAt,
  };
}

/**
 * Load every durable execution target for a canonical conversation, newest
 * first. Hidden continuation children are deliberately read through
 * `es_get_child_sessions`; they are not required to be present in the UI's
 * in-memory Session roster.
 */
export async function loadLocalConversationExecutionTargets(
  locator: ConversationRootLocator
): Promise<LocalConversationExecutionTargetSnapshot[]> {
  const candidates = await listExecutionCandidates(locator);
  const rows = await Promise.all(
    candidates.map(async (candidate) => ({
      candidate,
      row: await readExecutionRow(candidate.sessionId),
    }))
  );
  return rows
    .flatMap(({ candidate, row }) =>
      row
        ? [
            {
              sessionId: candidate.sessionId,
              updatedAt: row.updatedAt ?? candidate.updatedAt,
              target: row.target,
            },
          ]
        : []
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

async function candidateMatchesTarget(
  sessionId: string,
  target: LocalConversationTarget
): Promise<boolean> {
  const existing = (await readExecutionRow(sessionId))?.target ?? null;
  if (!existing) {
    log.info(
      `[native-continuation] skipping ${sessionId}: execution identity is unavailable`
    );
    return false;
  }
  // A model is a per-turn launch choice, not provider conversation identity.
  // The ordinary composer can already change models while preserving one
  // Session/native UUID. Treating it as an episode fingerprint caused a
  // Codex -> Claude -> Codex round trip to clone the original Codex
  // conversation whenever the picker selected a different compatible Codex
  // model on return. Runtime/profile/workspace still define the isolation
  // boundary; the selected model is passed to `sendMessage` below.
  const matches =
    sameOptional(existing.cliAgentType, target.cliAgentType) &&
    sameWorkspacePath(
      existing.workspaceRepoPath,
      target.workspaceRepoPath ?? undefined
    ) &&
    sameOptional(existing.accountId, target.accountId) &&
    sameOptional(existing.agentDefinitionId, target.agentDefinitionId);
  if (!matches) {
    log.info(
      `[native-continuation] skipping ${sessionId}: runtime identity does not match`,
      {
        existingRuntime: existing.cliAgentType ?? existing.agentDefinitionId,
        requestedRuntime: target.cliAgentType ?? target.agentDefinitionId,
        accountMatches: sameOptional(existing.accountId, target.accountId),
        workspaceMatches: sameWorkspacePath(
          existing.workspaceRepoPath,
          target.workspaceRepoPath ?? undefined
        ),
        existingWorkspace: comparableWorkspacePath(existing.workspaceRepoPath),
        requestedWorkspace: comparableWorkspacePath(
          target.workspaceRepoPath ?? undefined
        ),
      }
    );
  }
  return matches;
}

async function findCompatibleExecution(
  locator: ConversationRootLocator,
  target: LocalConversationTarget,
  timeline: readonly SessionEvent[],
  knownMatchingCandidates?: readonly ExecutionCandidate[]
): Promise<{
  sessionId: string;
  events: SessionEvent[];
} | null> {
  const canonicalItems = projectNativeConversationItems(timeline);
  const availableCandidates =
    knownMatchingCandidates ?? (await listExecutionCandidates(locator));
  // Candidates are newest-first. A provider switch makes the global frontier
  // belong to another runtime, but it does not invalidate the earlier native
  // UUID for this target. Reuse the newest target-compatible episode whose
  // native history is still a canonical prefix; synchronization below appends
  // the intervening cross-runtime delta before the next provider send.
  for (const candidate of availableCandidates) {
    if (
      !knownMatchingCandidates &&
      !(await candidateMatchesTarget(candidate.sessionId, target))
    ) {
      continue;
    }
    try {
      const loaded = await loadAuthoritativeSessionEvents(candidate.sessionId);
      const events = loaded.events;
      const executionItems = projectNativeConversationItems(events);
      // A newly-created child may legitimately be empty if the renderer died
      // between Session creation and native materialization. Empty is the
      // canonical zero-length prefix: synchronizeNativeConversation rebuilds
      // the provider transcript before sending the same durable turn intent.
      if (
        nativeConversationItemsAreProviderPortablePrefix(
          executionItems,
          canonicalItems
        )
      ) {
        return {
          sessionId: candidate.sessionId,
          events,
        };
      }
      // A compatible execution may contain unpublished partial/tool output.
      // Selecting an older UUID (or creating a fresh one) would silently omit
      // that output on Retry just as surely as ignoring the synchronizer's
      // prefix error. Explicit forks have their own root; an unexplained
      // branch inside this root requires reconciliation before another send.
      throw new QueuedConversationRecoveryBlockedError(
        `native history for ${candidate.sessionId} differs from the canonical conversation (native=${executionItems.length}, canonical=${canonicalItems.length}); reconcile the missing history before retrying`
      );
    } catch (error) {
      if (
        error instanceof QueuedConversationRecoveryPendingError ||
        error instanceof QueuedConversationRecoveryBlockedError
      ) {
        throw error;
      }
      // An unknown reader failure cannot prove that this episode is absent or
      // divergent. Fail closed and retry instead of silently selecting an
      // older provider-native UUID whose relative history is unknown.
      throw new QueuedConversationRecoveryPendingError(
        `native transcript for ${candidate.sessionId} is temporarily unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  return null;
}

/**
 * Keep EventStore's render/cache projection aligned after a target-native
 * episode has been synchronized from the canonical SessionEvent log. The
 * provider file is only that episode's execution format; the verified
 * canonical projection remains the conversation authority.
 */
async function hydrateSynchronizedConversationProjection(
  sessionId: string,
  before: readonly SessionEvent[],
  after: readonly SessionEvent[]
): Promise<void> {
  if (before.length === after.length && sameEventPrefix(before, after)) return;
  if (sameEventPrefix(before, after)) {
    await eventStoreProxy.mergeEvents(after.slice(before.length), sessionId);
    return;
  }
  await eventStoreProxy.set([...after], sessionId);
}

async function waitForTurnTerminal(
  sessionId: string,
  turnIntentId: string
): Promise<TurnTerminalStatus> {
  for (;;) {
    try {
      const terminal = await rpc.sessionCore.turnIntents.waitForTerminal({
        sessionId,
        turnIntentId,
        timeoutMs: TURN_WAIT_WINDOW_MS,
      });
      log.info(
        `[native-continuation] durable turn intent ${turnIntentId}: ${terminal.status}`
      );
      return toTurnTerminalStatus(terminal.status);
    } catch (error) {
      // A bounded long-poll timeout is not a turn timeout. Re-read the exact
      // durable row and open another window while the provider owns it.
      const current = await rpc.sessionCore.turnIntents.status({
        sessionId,
        turnIntentId,
      });
      if (
        current &&
        ["optimistic", "queued", "running"].includes(current.status)
      ) {
        continue;
      }
      if (current) {
        return toTurnTerminalStatus(current.status);
      }
      throw error;
    }
  }
}

function sameEventPrefix(
  before: readonly SessionEvent[],
  after: readonly SessionEvent[]
): boolean {
  return (
    before.length <= after.length &&
    before.every((event, index) => event.id === after[index]?.id)
  );
}

function sliceTurnTail(
  before: readonly SessionEvent[],
  after: readonly SessionEvent[],
  turnIntentId: string
): SessionEvent[] | null {
  let appended: readonly SessionEvent[];
  if (sameEventPrefix(before, after)) {
    appended = after.slice(before.length);
    const anchor = appended.findIndex(
      (event) =>
        event.source === "user" && conversationTurnIdOf(event) === turnIntentId
    );
    if (anchor < 0) return null;
    appended = appended.slice(anchor + 1);
  } else {
    const anchor = after.findIndex(
      (event) =>
        event.source === "user" && conversationTurnIdOf(event) === turnIntentId
    );
    if (anchor < 0) return null;
    appended = after.slice(anchor + 1);
  }
  return removeKnownNativeConversationEchoes(
    before,
    appended.filter((event) => event.source !== "user")
  );
}

/**
 * Provider-native transcripts cannot be required to persist ORG2's private
 * turn-intent id. After terminal, recover the structured native suffix by
 * proving that the complete pre-turn portable transcript is still an exact
 * semantic prefix, then locating the newly appended user message. This is a
 * role/tool transcript comparison; no history is rendered into a prompt.
 */
function sliceProviderNativeTail(
  before: readonly SessionEvent[],
  after: readonly SessionEvent[],
  turnIntentId: string,
  expectedRequest: ProviderRequestIdentity,
  logMismatch = true
): SessionEvent[] | null {
  const beforeItems = projectNativeConversationItems(before);
  const afterItems = projectNativeConversationItems(after);
  if (!nativeConversationItemsArePrefix(beforeItems, afterItems)) {
    if (logMismatch) {
      log.warn(
        `[native-continuation] native semantic prefix mismatch: before=${beforeItems.length}, after=${afterItems.length}`
      );
    }
    return null;
  }

  const appendedItems = afterItems.slice(beforeItems.length);
  const userIndex = appendedItems.findIndex(
    (item) =>
      item.kind === "message" &&
      item.role === "user" &&
      (item.turnId === turnIntentId ||
        nativeUserMessageMatchesRequest(item, expectedRequest))
  );
  if (userIndex < 0) {
    if (logMismatch) {
      log.warn(
        `[native-continuation] native suffix has no matching user anchor: appended=${appendedItems.length}`
      );
    }
    return null;
  }

  const tailEventIds = new Set(
    appendedItems.slice(userIndex + 1).map(sourceEventIdOfNativeItem)
  );
  if (tailEventIds.size === 0) return [];
  const tail = after.filter(
    (event) =>
      event.source !== "user" && tailEventIds.has(nativeSourceEventId(event))
  );
  log.info(
    `[native-continuation] recovered provider-native tail: items=${tailEventIds.size}, events=${tail.length}`
  );
  return tail;
}

function resolveSettledTail(
  before: readonly SessionEvent[],
  events: readonly SessionEvent[],
  turnIntentId: string,
  expectedRequest: ProviderRequestIdentity,
  logMismatch: boolean
): SessionEvent[] | null {
  const identifiedTail = sliceTurnTail(before, events, turnIntentId);
  if (identifiedTail && identifiedTail.length > 0) return identifiedTail;
  return sliceProviderNativeTail(
    before,
    events,
    turnIntentId,
    expectedRequest,
    logMismatch
  );
}

async function loadSettledTail(
  sessionId: string,
  before: readonly SessionEvent[],
  turnIntentId: string,
  expectedRequest: ProviderRequestIdentity,
  preserveInterruptedSuffix: boolean
): Promise<{ agentTail: SessionEvent[]; events: SessionEvent[] }> {
  const reconcileOptions = {
    preserveInterruptedSuffix,
  };
  let events = await reconcileNativeTranscript(sessionId, reconcileOptions);
  let agentTail = resolveSettledTail(
    before,
    events,
    turnIntentId,
    expectedRequest,
    false
  );
  if (agentTail) return { agentTail, events };
  if (preserveInterruptedSuffix) {
    if (providerClosedTurnWithoutRecordingPrompt(before, events)) {
      // Stop reached the provider before it persisted the prompt: the native
      // transcript gained only the turn's closing lifecycle marker and no
      // portable item. Nothing further will converge, so this is the same
      // durable empty-tail boundary as a user-only interrupted turn. The
      // accepted user row stays on the canonical timeline for the next send.
      log.warn(
        `[native-continuation] ${turnIntentId} was interrupted before the provider recorded its prompt; settling an empty tail`
      );
      return { agentTail: [], events };
    }
    // `resolveSettledTail` returns [] (which is truthy) when the provider
    // transcript contains the accepted user anchor but no assistant/tool
    // output. `null` is materially different: the accepted turn has not yet
    // converged into the native transcript/EventStore projection. Keep the
    // durable queue item recovery-pending rather than publishing a false
    // empty-tail success and losing the user's interrupted turn on rollover.
    throw new QueuedConversationRecoveryPendingError(
      `conversation turn ${turnIntentId} is missing its interrupted native transcript anchor`
    );
  }

  // Backend terminal publication normally makes the first read complete.
  // Retry only after this concrete semantic mismatch, never as a fixed delay
  // in every queued turn's critical path.
  events = await recoverNativeTranscriptAfterMismatch(
    sessionId,
    events,
    (candidate) =>
      resolveSettledTail(
        before,
        candidate,
        turnIntentId,
        expectedRequest,
        false
      ) !== null,
    reconcileOptions
  );
  agentTail = resolveSettledTail(
    before,
    events,
    turnIntentId,
    expectedRequest,
    true
  );
  if (agentTail) return { agentTail, events };
  throw new Error(
    `conversation turn ${turnIntentId} is missing its native transcript anchor`
  );
}

const TURN_CLOSING_LIFECYCLE_ACTIONS = new Set([
  "task_completed",
  "task_failed",
]);

/**
 * True when the provider transcript grew past the pre-turn prefix only by a
 * closing task lifecycle marker: the provider finalized (aborted) the turn
 * without ever recording the prompt or any portable output. The portable item
 * list is unchanged, so no user anchor can appear later.
 */
export function providerClosedTurnWithoutRecordingPrompt(
  before: readonly SessionEvent[],
  after: readonly SessionEvent[]
): boolean {
  const beforeItems = projectNativeConversationItems(before);
  const afterItems = projectNativeConversationItems(after);
  if (
    afterItems.length !== beforeItems.length ||
    !nativeConversationItemsArePrefix(beforeItems, afterItems)
  ) {
    return false;
  }
  const knownIds = new Set(before.map((event) => event.id));
  return after.some(
    (event) =>
      !knownIds.has(event.id) &&
      TURN_CLOSING_LIFECYCLE_ACTIONS.has(event.actionType)
  );
}

interface ProviderRequestIdentity {
  text: string;
  images: readonly string[];
}

function normalizeProviderRequestText(value: string): string {
  // Native stores can normalize platform line endings while preserving the
  // message byte-for-byte otherwise. Do not trim or use suffix matching:
  // whitespace and provider context wrappers are part of the real payload.
  return value.replace(/\r\n?/g, "\n");
}

function sameProviderImages(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => item === right[index])
  );
}

function nativeUserMessageMatchesRequest(
  item: {
    text: string;
    images: readonly string[];
  },
  expected: ProviderRequestIdentity
): boolean {
  return (
    normalizeProviderRequestText(item.text) ===
      normalizeProviderRequestText(expected.text) &&
    sameProviderImages(item.images, expected.images)
  );
}

async function finishConversationTurn(params: {
  sessionId: string;
  before: readonly SessionEvent[];
  turnIntentId: string;
  providerRequest: ProviderRequestIdentity;
  generation: number;
  /** Recovery created this frontend lifecycle after provider acceptance. */
  settleAdoptedLifecycle?: boolean;
}): Promise<
  Pick<ContinueLocalConversationResult, "terminalStatus" | "agentTail">
> {
  const terminalStatus = await waitForTurnTerminal(
    params.sessionId,
    params.turnIntentId
  );
  // Keep the exact turn generation active until its authoritative tail is in
  // EventStore. Releasing the FSM at the durable provider terminal would let
  // the ordinary Session queue inject a follow-up against a stale transcript.
  const settled = await loadSettledTail(
    params.sessionId,
    params.before,
    params.turnIntentId,
    params.providerRequest,
    terminalStatus === "cancelled" || terminalStatus === "failed"
  );
  // Fresh sends are closed only by the CLI/Agent lifecycle coordinator.
  // Crash recovery created a synthetic frontend lifecycle after the original
  // terminal event, so it alone closes that adopted generation here.
  if (params.settleAdoptedLifecycle) {
    settleUserIntentLifecycle(params, terminalStatus);
  }
  return {
    terminalStatus,
    agentTail: settled.agentTail,
  };
}

async function prepareConversationTurn(
  sessionId: string,
  params: Pick<
    ContinueLocalConversationParams,
    "displayText" | "imageDataUrls" | "turnIntentId"
  >,
  runtimeStatusSource: UserIntentPreparation["runtimeStatusSource"]
): Promise<ConversationTurnPreparation> {
  return prepareUserIntent({
    sessionId,
    visibleText: params.displayText,
    imageDataUrls: params.imageDataUrls,
    turnIntentId: params.turnIntentId,
    runtimeStatusSource,
  });
}

async function dispatchConversationMessage(
  sessionId: string,
  params: Omit<ContinueLocalConversationParams, "timeline">,
  options: {
    allowNativeContextRecovery: boolean;
    runtimeStatusSource: UserIntentPreparation["runtimeStatusSource"];
    preparation?: ConversationTurnPreparation;
  }
): ReturnType<typeof dispatchUserIntent> {
  return dispatchUserIntent({
    sessionId,
    visibleText: params.displayText,
    imageDataUrls: params.imageDataUrls,
    runtimeStatusSource: options.runtimeStatusSource,
    preparation: options.preparation,
    send: {
      content: params.agentContent ?? params.displayText,
      displayText: params.displayText,
      model: params.target.model,
      accountId: params.target.accountId,
      mode: "build",
      clientMessageId: `conversation-turn:${params.turnIntentId}`,
      turnIntentId: params.turnIntentId,
      turnIntentSource: "user_submit",
      directUserIntent: true,
      allowNativeContextRecovery: options.allowNativeContextRecovery,
    },
  });
}

async function createConversationExecution(
  params: Pick<ContinueLocalConversationParams, "root" | "title" | "target">
): Promise<{ sessionId: string }> {
  return SessionService.create({
    task: "",
    name: params.title,
    repoPath: params.target.workspaceRepoPath ?? undefined,
    model: params.target.model,
    accountId: params.target.accountId,
    cliAgentType: params.target.cliAgentType,
    keySource: "own_key",
    agentDefinitionId: params.target.agentDefinitionId,
    parentSessionId: conversationExecutionParentId(params.root),
    mode: "build",
  });
}

async function materializeCreatedConversation(
  sessionId: string,
  params: Pick<ContinueLocalConversationParams, "timeline">
) {
  // SessionEvent is the sole conversation authority. Even when the imported
  // source and target happen to be the same provider, a new execution episode
  // is rebuilt from the canonical role/tool event list instead of adopting a
  // provider file. This guarantees Team Chat and turns produced by every
  // other runtime participate in exactly the same target-native transcript.
  return materializeNativeConversation({
    sessionId,
    timeline: params.timeline,
  });
}

interface CreatedConversationOptions {
  loadTimeline: () => Promise<readonly SessionEvent[]>;
  onSessionCreated?: (sessionId: string) => void | Promise<void>;
}

async function runCreatedConversationTurn(
  params: Omit<ContinueLocalConversationParams, "timeline">,
  options: CreatedConversationOptions
): Promise<ContinueLocalConversationResult> {
  const created = await createConversationExecution(params);
  let materialized:
    | Awaited<ReturnType<typeof materializeCreatedConversation>>
    | undefined;
  // Keep ownership of the eager visible preparation while launch is still
  // pending. If session_launch rejects (bad OAuth, offline CLI, etc.), close
  // that exact generation immediately instead of leaving the composer to the
  // dispatching dead-man.
  let preparation: ConversationTurnPreparation | null = null;
  try {
    preparation = await prepareConversationTurn(
      created.sessionId,
      params,
      "launch"
    );
    // Native transcript conversion can take materially longer than provider
    // startup. Promote preparation out of the dispatch dead-man while keeping
    // the same shared direct-turn lifecycle used by ordinary composer sends.
    confirmUserIntentPreparation(preparation);
    await options.onSessionCreated?.(created.sessionId);
    activateUserIntentPreparation(preparation);
    const timeline = (await options.loadTimeline()).filter(
      (event) => conversationTurnIdOf(event) !== params.turnIntentId
    );
    materialized = await materializeCreatedConversation(created.sessionId, {
      timeline,
    });
    // CLI native files are outside EventStore, so seed their verified replay
    // for an immediate first render. Rust Agent materialization already
    // hydrates its own EventStore; setting the same rows here would duplicate
    // each user message under the Agent history adapter's normalized id.
    if (params.target.cliAgentType) {
      await eventStoreProxy.set(
        [...materialized.events, preparation.userEvent],
        created.sessionId
      );
    }
    await params.onSessionReady?.(
      created.sessionId,
      materialized.events.length
    );
    await params.onBeforeTurnDispatch?.(created.sessionId);
    const dispatched = await dispatchConversationMessage(
      created.sessionId,
      params,
      {
        // A fresh episode was rebuilt from the canonical role/tool list, so
        // provider-native compact/rollover may recover a target-window limit.
        allowNativeContextRecovery: true,
        runtimeStatusSource: "launch",
        preparation,
      }
    );
    preparation = dispatched.preparation;
  } catch (error) {
    log.error(
      `[localConversationContinuation] launch turn failed for ${created.sessionId}:`,
      error
    );
    if (preparation) {
      if (error instanceof QueuedConversationRecoveryPendingError) throw error;
      await failUserIntentPreparation(preparation, error).catch(
        () => undefined
      );
      throw isUserIntentSendError(error)
        ? error
        : new UserIntentSendError(error, preparation.userEvent.id);
    }
    throw error;
  }

  await notifyConversationTurnAccepted(
    params.onTurnAccepted,
    created.sessionId,
    params.turnIntentId
  );

  if (!materialized) {
    throw new Error("conversation materialization completed without a receipt");
  }
  if (!preparation) {
    throw new Error("conversation dispatch completed without a preparation");
  }

  const finished = await finishConversationTurn({
    sessionId: created.sessionId,
    before: materialized.events,
    turnIntentId: params.turnIntentId,
    providerRequest: {
      text: params.agentContent ?? params.displayText,
      images: params.imageDataUrls ?? [],
    },
    generation: preparation.generation,
  });
  return {
    sessionId: created.sessionId,
    terminalStatus: finished.terminalStatus,
    agentTail: finished.agentTail,
  };
}

async function continueLocalConversationAtQueueHead(
  params: ContinueLocalConversationParams,
  knownCandidates?: readonly ExecutionCandidate[],
  reloadTimelineForRollover?: () => Promise<readonly SessionEvent[]>
): Promise<ContinueLocalConversationResult> {
  // Queue admission renders the new user row immediately on the canonical
  // source. Materialization must rebuild the transcript *before* that turn;
  // the provider receives it exactly once through dispatchUserIntent below.
  const effectiveParams = {
    ...params,
    timeline: params.timeline.filter(
      (event) => conversationTurnIdOf(event) !== params.turnIntentId
    ),
  };
  // Publishing the canonical user turn is independent of local execution
  // discovery. Cloud/root surfaces can render it while a native episode is
  // still being verified or materialized.
  const compatible = await findCompatibleExecution(
    effectiveParams.root,
    effectiveParams.target,
    effectiveParams.timeline,
    knownCandidates
  );
  if (compatible) {
    const preparation = await prepareConversationTurn(
      compatible.sessionId,
      effectiveParams,
      "dispatch"
    );
    // Synchronizing a large canonical delta is part of the accepted user
    // intent, not a pre-submit loading screen. Use the same optimistic row,
    // generation, and planning footer as an ordinary queued send before any
    // provider-native I/O begins.
    confirmUserIntentPreparation(preparation);
    let dispatched: Awaited<ReturnType<typeof dispatchConversationMessage>>;
    try {
      await effectiveParams.onSessionPreparing?.(compatible.sessionId);
      activateUserIntentPreparation(preparation);
      const beforeSynchronization = compatible.events;
      const synchronized = await synchronizeNativeConversation({
        sessionId: compatible.sessionId,
        timeline: effectiveParams.timeline,
      });
      compatible.events = synchronized.events;
      if (effectiveParams.target.cliAgentType) {
        await hydrateSynchronizedConversationProjection(
          compatible.sessionId,
          beforeSynchronization,
          synchronized.events
        );
      }
      // Reveal/follow the writable episode before dispatch. The ordinary
      // optimistic row and planning footer are already mounted while native
      // synchronization runs; this exact boundary only opens the live event
      // overlay at the verified pre-turn prefix.
      await effectiveParams.onSessionReady?.(
        compatible.sessionId,
        compatible.events.length
      );
      await effectiveParams.onBeforeTurnDispatch?.(compatible.sessionId);
      dispatched = await dispatchConversationMessage(
        compatible.sessionId,
        effectiveParams,
        {
          // Permission is not a trigger: the native transport still requires
          // an explicit context-exhausted terminal with zero assistant/tool
          // output. A compatible episode is already synchronized to the
          // canonical prefix, so provider-native compact/rollover is the
          // cheapest first recovery. The fresh canonical rebuild below
          // remains the fallback when native recovery itself fails.
          allowNativeContextRecovery: true,
          runtimeStatusSource: "dispatch",
          preparation,
        }
      );
    } catch (error) {
      if (error instanceof QueuedConversationRecoveryPendingError) throw error;
      const rebuildReason = isCodexNativeEpisodeAlreadyOwned(
        error,
        effectiveParams.target
      )
        ? "its native UUID has an active writer"
        : null;
      if (rebuildReason) {
        const rolloverTimeline = reloadTimelineForRollover
          ? await reloadTimelineForRollover()
          : effectiveParams.timeline;
        // The native App exclusively owns this UUID, but synchronization has
        // already verified its history against the canonical timeline.
        // Discard only this failed optimistic echo and rebuild a fresh episode.
        // A prefix mismatch is NOT a rollover signal: rebuilding from a shorter
        // or divergent plane could silently omit native-only tool/output rows.
        // That error follows the ordinary visible failed-intent path below.
        // runCreatedConversationTurn does not recurse through candidate lookup,
        // which bounds this recovery to one automatic resend of the same intent.
        await eventStoreProxy.removeSyntheticUserInputEvents(
          compatible.sessionId,
          {
            matchingContents: [],
            matchingTurnIntentIds: [effectiveParams.turnIntentId],
          }
        );
        log.info(
          `[localConversationContinuation] rebuilding episode ${compatible.sessionId} because ${rebuildReason}`
        );
        return runCreatedConversationTurn(effectiveParams, {
          loadTimeline: async () => rolloverTimeline,
          onSessionCreated: effectiveParams.onSessionPreparing,
        });
      }
      log.error(
        `[localConversationContinuation] resume turn failed for ${compatible.sessionId}:`,
        error
      );
      await failUserIntentPreparation(preparation, error).catch(
        () => undefined
      );
      throw isUserIntentSendError(error)
        ? error
        : new UserIntentSendError(error, preparation.userEvent.id);
    }
    await notifyConversationTurnAccepted(
      effectiveParams.onTurnAccepted,
      compatible.sessionId,
      effectiveParams.turnIntentId
    );
    const finished = await finishConversationTurn({
      sessionId: compatible.sessionId,
      before: compatible.events,
      turnIntentId: effectiveParams.turnIntentId,
      providerRequest: {
        text: effectiveParams.agentContent ?? effectiveParams.displayText,
        images: effectiveParams.imageDataUrls ?? [],
      },
      generation: dispatched.preparation.generation,
    });
    return {
      sessionId: compatible.sessionId,
      terminalStatus: finished.terminalStatus,
      agentTail: finished.agentTail,
    };
  }

  return runCreatedConversationTurn(effectiveParams, {
    loadTimeline: async () => effectiveParams.timeline,
    onSessionCreated: effectiveParams.onSessionPreparing,
  });
}

function assertSupportedConversationTarget(
  target: LocalConversationTarget
): void {
  if (!supportsNativeConversationTarget(target)) {
    throw new Error(
      `target ${target.cliAgentType ?? "native"} cannot materialize a provider-native role/tool transcript`
    );
  }
}

/**
 * Reconnect a durable queue row to a provider turn accepted before this
 * renderer stopped. `session_turn_intents` is the acceptance authority; the
 * queue contributes only the concrete runner address needed to find it.
 * Returning `null` proves the backend never accepted this intent, so the
 * caller may safely run the ordinary dispatch path with the same id.
 */
export async function recoverLocalConversationTurn(
  params: RecoverLocalConversationParams
): Promise<ContinueLocalConversationResult | null> {
  assertSupportedConversationTarget(params.target);
  const durableIntent = await rpc.sessionCore.turnIntents.status({
    sessionId: params.runnerSessionId,
    turnIntentId: params.turnIntentId,
  });
  if (!durableIntent || durableIntent.status === "optimistic") return null;
  if (["stale", "coalesced", "rejected"].includes(durableIntent.status)) {
    throw new QueuedConversationRecoveryBlockedError(
      `conversation turn was retired before provider execution (${durableIntent.status}); edit or retry it as a new intent`
    );
  }

  // The backend turn-intent row is the provider-acceptance authority. A
  // renderer can stop after that row becomes queued/running/terminal but
  // before the frontend delivery receipt advances from `preparing`. Restore
  // that irreversible boundary before doing any transcript/candidate reads:
  // those reads may remain temporarily unavailable, but the queue must never
  // present the accepted user turn as Sending or make it eligible for a fresh
  // provider launch.
  await params.onBeforeTurnDispatch?.(params.runnerSessionId);
  await notifyConversationTurnAccepted(
    params.onTurnAccepted,
    params.runnerSessionId,
    params.turnIntentId
  );

  const candidates = await listExecutionCandidates(params.root);
  const belongsToRoot =
    candidates.some(
      (candidate) => candidate.sessionId === params.runnerSessionId
    ) ||
    (params.root.authority === "local-session" &&
      params.root.conversationId === params.runnerSessionId);
  if (
    !belongsToRoot ||
    !(await candidateMatchesTarget(params.runnerSessionId, params.target))
  ) {
    throw new QueuedConversationRecoveryBlockedError(
      "durable conversation runner no longer belongs to this root/target"
    );
  }

  const timeline = params.timeline.filter(
    (event) => conversationTurnIdOf(event) !== params.turnIntentId
  );
  const { events } = await loadAuthoritativeSessionEvents(
    params.runnerSessionId
  );
  const canonicalItems = projectNativeConversationItems(timeline);
  const executionItems = projectNativeConversationItems(events);
  if (
    !nativeConversationItemsAreProviderPortablePrefix(
      canonicalItems,
      executionItems
    )
  ) {
    throw new QueuedConversationRecoveryBlockedError(
      "accepted conversation runner diverged from the canonical transcript"
    );
  }

  const adopted = adoptAcceptedUserIntent({
    sessionId: params.runnerSessionId,
    turnIntentId: params.turnIntentId,
    runtimeStatusSource: "dispatch",
  });
  try {
    await params.onSessionPreparing?.(params.runnerSessionId);
    await params.onSessionReady?.(
      params.runnerSessionId,
      params.eventStartIndex ?? timeline.length
    );
    const finished = await finishConversationTurn({
      sessionId: params.runnerSessionId,
      before: timeline,
      turnIntentId: params.turnIntentId,
      providerRequest: {
        text: params.agentContent ?? params.displayText,
        images: params.imageDataUrls ?? [],
      },
      generation: adopted.generation,
      settleAdoptedLifecycle: true,
    });
    return {
      sessionId: params.runnerSessionId,
      terminalStatus: finished.terminalStatus,
      agentTail: finished.agentTail,
    };
  } catch (error) {
    if (error instanceof QueuedConversationRecoveryPendingError) throw error;
    throw new QueuedConversationRecoveryPendingError(
      error instanceof Error ? error.message : String(error)
    );
  }
}

export async function continueLocalConversation(
  params: ContinueLocalConversationParams
): Promise<ContinueLocalConversationResult> {
  assertSupportedConversationTarget(params.target);
  return continueLocalConversationAtQueueHead(params);
}

/**
 * Continue a canonical conversation whose authoritative history is mutable.
 * History is loaded only after the application's singleton durable queue has
 * granted this root its turn. Serialization belongs to
 * useQueueDispatch/turnLifecycle, not to this provider adapter.
 */
export async function continueLocalConversationAfterTimelineLoad(
  params: ContinueLocalConversationAfterTimelineLoadParams
): Promise<ContinueLocalConversationResult> {
  assertSupportedConversationTarget(params.target);
  const { loadTimeline, ...continuationParams } = params;
  const candidates = await listExecutionCandidates(params.root);
  const matchingCandidates: ExecutionCandidate[] = [];
  for (const candidate of candidates) {
    if (await candidateMatchesTarget(candidate.sessionId, params.target)) {
      matchingCandidates.push(candidate);
    }
  }
  if (matchingCandidates.length === 0) {
    // No native episode could possibly be reused. Create the ordinary Session
    // before parsing a potentially large imported transcript so its pending
    // row, footer and follow-up queue appear through the existing UI path.
    return runCreatedConversationTurn(continuationParams, {
      loadTimeline,
      onSessionCreated: params.onSessionPreparing,
    });
  }
  const timeline = await loadTimeline();
  return continueLocalConversationAtQueueHead(
    { ...continuationParams, timeline },
    matchingCandidates,
    loadTimeline
  );
}
