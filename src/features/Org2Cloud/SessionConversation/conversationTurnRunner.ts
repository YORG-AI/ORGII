/**
 * Conversation turn runner — the write half of the 0024 conversation-events
 * plane (design: docs/conversation-events-plane-design-2026-08-21.md).
 *
 * When a member chats in a conversation they do not own, the turn executes
 * in a LOCAL, invisible one-shot runner session on their machine
 * (sender-runs / sender-pays) and the resulting events are pushed —
 * author-stamped — to the shared plane. No fork, no transcript copy, no new
 * sidebar entity.
 *
 * ONE-SHOT per turn: `SessionService.create` is the only dispatch primitive
 * proven headless (Routine/work-item background runs ride it), so every
 * turn gets a fresh runner with the full bounded conversation context
 * injected (the external-history handoff pattern) — never a dispatch into
 * an unmounted surface. Runner sessions are plumbing: the caller forces
 * their cloud sync OFF, and `collectConversationRunnerSessionIds` hides
 * them from My Sessions.
 *
 * Push order is Slack-shaped: the user's message row goes out FIRST (every
 * client sees it instantly), the agent tail follows under the same turnId
 * when the local run completes.
 */
import Message from "@src/components/Message";
import {
  getLastTurnTerminal,
  turnLifecycleSignalAtom,
} from "@src/engines/SessionCore/control/turnLifecycle";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { SessionService } from "@src/engines/SessionCore/services/SessionService";
import { mintTurnIntentId } from "@src/engines/SessionCore/sync/adapters/shared/eventFactories";
import { requestForkSessionSetup } from "@src/features/TeamCollaboration/forkSession";
import {
  clearForkSetupMemory,
  loadForkSetupMemory,
  saveForkSetupMemory,
} from "@src/features/TeamCollaboration/forkSetupMemory";
import { createLogger } from "@src/hooks/logger";
import i18n from "@src/i18n";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import {
  boundConversationEventForPush,
  pushConversationEvents,
  pushConversationEventsChunked,
} from "../org2CloudConversationEventsClient";

const log = createLogger("ConversationTurnRunner");

const RUNNER_REGISTRY_KEY = "orgii:conversation-runners-v1";
const TURN_DEADLINE_MS = 15 * 60_000;
const CONTEXT_MAX_ENTRIES = 60;
const CONTEXT_MAX_ENTRY_CHARS = 600;
const CONTEXT_MAX_TOTAL_CHARS = 18_000;

interface RunnerRegistryEntry {
  /** Every one-shot runner this device created for the conversation. */
  runnerSessionIds: string[];
  updatedAt: string;
}

type RunnerRegistry = Record<string, RunnerRegistryEntry>;

function registryKey(orgId: string, rootSessionId: string): string {
  return `${orgId}:${rootSessionId}`;
}

function readRegistry(): RunnerRegistry {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(RUNNER_REGISTRY_KEY);
    return raw ? (JSON.parse(raw) as RunnerRegistry) : {};
  } catch {
    return {};
  }
}

function writeRegistry(registry: RunnerRegistry): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(RUNNER_REGISTRY_KEY, JSON.stringify(registry));
  } catch {
    // Best-effort: losing the registry only means runners stop being hidden.
  }
}

/** Every runner session id on this device — the My Sessions hide filter. */
export function collectConversationRunnerSessionIds(): Set<string> {
  const ids = new Set<string>();
  for (const entry of Object.values(readRegistry())) {
    for (const id of entry.runnerSessionIds ?? []) ids.add(id);
  }
  return ids;
}

/** Conversation timeline rendered as a bounded read-only context block. */
export function renderConversationContext(
  timeline: readonly SessionEvent[],
  senders?: ReadonlyMap<string, string>
): string {
  const tail = timeline.slice(-CONTEXT_MAX_ENTRIES);
  const lines: string[] = [];
  let total = 0;
  for (const event of tail) {
    const text = event.displayText?.trim();
    if (!text) continue;
    const speaker =
      event.source === "user"
        ? (senders?.get(event.id) ?? "User")
        : "Assistant";
    let line = `${speaker}: ${text.replace(/\s+/g, " ")}`;
    if (line.length > CONTEXT_MAX_ENTRY_CHARS) {
      line = `${line.slice(0, CONTEXT_MAX_ENTRY_CHARS)}…`;
    }
    if (total + line.length > CONTEXT_MAX_TOTAL_CHARS) break;
    total += line.length;
    lines.push(line);
  }
  return lines.join("\n");
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

async function waitForFirstTurnTerminal(
  sessionId: string,
  deadlineMs: number
): Promise<void> {
  const store = getInstrumentedStore();
  const isComplete = (): boolean => getLastTurnTerminal(sessionId) !== null;
  if (isComplete()) return;
  await new Promise<void>((resolve, reject) => {
    const remainingMs = deadlineMs - Date.now();
    if (remainingMs <= 0) {
      reject(new Error("conversation turn timed out"));
      return;
    }
    let unsubscribe: (() => void) | null = null;
    const timer = setTimeout(() => {
      unsubscribe?.();
      reject(new Error("conversation turn timed out"));
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

/**
 * The pushed user row is SYNTHESIZED from the user's visible words — the
 * runner's own persisted user event carries the injected context prefix,
 * which must never leak into the shared conversation.
 */
function buildPushedUserEvent(
  sessionId: string,
  displayText: string,
  createdAt: string
): SessionEvent {
  const id = `convturn-user-${mintTurnIntentId()}`;
  return {
    id,
    chunk_id: id,
    sessionId,
    createdAt,
    functionName: "user_message",
    uiCanonical: "user_message",
    actionType: "raw",
    args: {},
    result: { type: "user", message: { content: displayText, role: "user" } },
    source: "user",
    displayText,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "agent",
    payloadRefs: [],
  } as SessionEvent;
}

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
  /** Merged conversation timeline for the read-only context prefix. */
  timeline: readonly SessionEvent[];
  sourceScopeKey?: string;
  sourceModel?: string;
  /**
   * Called as soon as the one-shot runner session id is known, with the
   * turnId the tail will be pushed under. The caller overlays the runner's
   * LIVE events until the plane carries this turnId.
   */
  onRunnerReady?: (runnerSessionId: string, turnId: string) => void;
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
}

export async function runConversationTurn(
  params: RunConversationTurnParams
): Promise<RunConversationTurnResult> {
  const key = registryKey(params.orgId, params.rootSessionId);
  const contextBlock = renderConversationContext(params.timeline);
  const request = params.agentContent ?? params.displayText;
  const deadlineMs = Date.now() + TURN_DEADLINE_MS;
  const dispatchIso = new Date().toISOString();
  const turnId = crypto.randomUUID();

  // The execution setup must exist BEFORE the user's words go public — a
  // cancelled setup dialog cancels the whole send. Per-repo-scope memory
  // keeps this silent after the first confirmation (the forkTeammateSession
  // idiom): dialog once, remember, reuse with a toast; a failed remembered
  // launch clears the memory and re-prompts exactly once below.
  const remembered = loadForkSetupMemory(params.sourceScopeKey);
  let usedRememberedSetup = Boolean(remembered);
  let setup =
    remembered ??
    (await requestForkSessionSetup({
      sourceTitle: params.conversationTitle,
      sourceScopeKey: params.sourceScopeKey,
      sourceModel: params.sourceModel,
    }));
  if (!remembered) saveForkSetupMemory(params.sourceScopeKey, setup);

  await pushConversationEvents(await params.getAccessToken(), {
    orgId: params.orgId,
    rootSessionId: params.rootSessionId,
    turnId,
    events: [
      boundConversationEventForPush(
        buildPushedUserEvent("conversation", params.displayText, dispatchIso)
      ),
    ],
  });
  params.onPushed?.();
  params.onUserMessagePublished?.();

  const createRunner = () =>
    SessionService.create({
      task: buildRunnerPrompt(contextBlock, request),
      imageDataUrls: params.imageDataUrls,
      name: params.conversationTitle,
      repoPath: setup.workspaceRepoPath ?? undefined,
      model: setup.execution.model,
      accountId: setup.execution.accountId,
      keySource: "own_key",
      agentDefinitionId: setup.execution.agentDefinitionId,
      mode: "build",
    });
  let created;
  try {
    created = await createRunner();
  } catch (error) {
    if (!usedRememberedSetup) throw error;
    // The remembered setup went stale (checkout moved, account or model
    // removed). Drop it and fall back to the dialog once.
    log.warn("remembered runner setup failed; re-prompting", error);
    clearForkSetupMemory(params.sourceScopeKey);
    setup = await requestForkSessionSetup({
      sourceTitle: params.conversationTitle,
      sourceScopeKey: params.sourceScopeKey,
      sourceModel: params.sourceModel,
    });
    saveForkSetupMemory(params.sourceScopeKey, setup);
    usedRememberedSetup = false;
    created = await createRunner();
  }
  if (usedRememberedSetup) {
    Message.info(
      i18n.t("navigation:collaboration.session.forkSetupReused", {
        model: setup.execution.model ?? setup.execution.agentDefinitionId,
      })
    );
  }
  const runnerSessionId = created.sessionId;
  const registry = readRegistry();
  const entry = registry[key];
  writeRegistry({
    ...registry,
    [key]: {
      runnerSessionIds: [...(entry?.runnerSessionIds ?? []), runnerSessionId],
      updatedAt: dispatchIso,
    },
  });
  params.onRunnerReady?.(runnerSessionId, turnId);
  await waitForFirstTurnTerminal(runnerSessionId, deadlineMs);

  const persisted = await eventStoreProxy
    .getPersistedEvents(runnerSessionId)
    .catch(() => [] as SessionEvent[]);
  // The runner's own user event carries the injected context prefix (never
  // pushed — the clean user row already went out in push #1); the agent and
  // tool tail is the shared payload.
  const agentTail = persisted
    .filter((event) => event.source !== "user")
    .map(boundConversationEventForPush);

  if (agentTail.length > 0) {
    await pushConversationEventsChunked(await params.getAccessToken(), {
      orgId: params.orgId,
      rootSessionId: params.rootSessionId,
      turnId,
      events: agentTail,
    });
    params.onPushed?.();
  }
  log.info(
    `pushed conversation turn ${turnId}: 1 + ${agentTail.length} event(s) to ${key}`
  );
  return { runnerSessionId, pushedEventCount: 1 + agentTail.length };
}
