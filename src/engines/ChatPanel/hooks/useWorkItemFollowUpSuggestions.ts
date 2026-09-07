import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  type SessionFollowUpMessage,
  type SessionFollowUpSuggestion,
  type SessionFollowUpSuggestionsResponse,
  sessionFollowUpSuggestions,
} from "@src/api/services/sessionFollowUpSuggestions";
import {
  getLastTurnTerminal,
  getTurnGeneration,
  getTurnPhase,
  turnLifecycleSignalAtom,
} from "@src/engines/SessionCore/control/turnLifecycle";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import type { Session } from "@src/store/session/sessionAtom/types";
import { settingAtom } from "@src/store/settings/settingsAtom";

const FOLLOW_UP_CONTEXT_MESSAGES = 6;
const FOLLOW_UP_MAX_CONCURRENT_SESSIONS = 4;

interface WorkItemFollowUpScope {
  sessionId: string;
  orgId: string;
  workItemId: string;
}

interface FollowUpProviderIdentity {
  accountId: string;
  model: string;
}

interface FollowUpRequest {
  sessionId: string;
  generation: number;
  messages: SessionFollowUpMessage[];
}

type FollowUpGenerator = (
  request: FollowUpRequest
) => Promise<SessionFollowUpSuggestionsResponse>;

interface FollowUpRequestCoordinator {
  request: (
    request: FollowUpRequest,
    generate?: FollowUpGenerator
  ) => Promise<SessionFollowUpSuggestion[] | null>;
  inFlightCount: () => number;
}

interface ActiveRequest {
  generation: number;
  promise: Promise<SessionFollowUpSuggestion[] | null>;
}

interface PendingRequest {
  request: FollowUpRequest;
  generate: FollowUpGenerator;
  promise: Promise<SessionFollowUpSuggestion[] | null>;
  resolve: (suggestions: SessionFollowUpSuggestion[] | null) => void;
}

interface SessionRequestState {
  active: ActiveRequest;
  pending: PendingRequest | null;
}

export interface FollowUpLifecycleObservation {
  scopeKey: string;
  observedGeneration: number;
  observedWorkingGeneration: number | null;
  assistantBaseline: string | null;
  handledTerminalGeneration: number | null;
}

export interface FollowUpLifecycleSnapshot {
  phase: ReturnType<typeof getTurnPhase>;
  generation: number;
  terminal: ReturnType<typeof getLastTurnTerminal>;
  assistantFingerprint: string | null;
}

interface FollowUpResultGuardInput {
  requestEpoch: number;
  currentRequestEpoch: number;
  expectedContextKey: string;
  currentContextKey: string;
  phase: ReturnType<typeof getTurnPhase>;
  expectedGeneration: number;
  terminal: ReturnType<typeof getLastTurnTerminal>;
}

interface UseWorkItemFollowUpSuggestionsInput {
  sessionId: string;
  inputAreaSessionId: string;
  session: Session | null | undefined;
  events: ReadonlyArray<SessionEvent>;
}

export interface WorkItemFollowUpSuggestionsState {
  suggestions: SessionFollowUpSuggestion[];
  clearSuggestions: () => void;
}

async function invokeFollowUpGenerator(
  request: FollowUpRequest
): Promise<SessionFollowUpSuggestionsResponse> {
  return sessionFollowUpSuggestions(request.sessionId, request.messages);
}

export function createFollowUpRequestCoordinator(
  maxConcurrentSessions = FOLLOW_UP_MAX_CONCURRENT_SESSIONS
): FollowUpRequestCoordinator {
  // A session owns one active pass and at most one latest pending generation.
  // This preserves single-flight without losing a fast second completed turn;
  // any intermediate pending generation is resolved as a silent no-op.
  const inFlight = new Map<string, SessionRequestState>();

  function execute(
    request: FollowUpRequest,
    generate: FollowUpGenerator
  ): Promise<SessionFollowUpSuggestion[] | null> {
    try {
      return Promise.resolve(generate(request))
        .then((response) => response.suggestions)
        .catch(() => null);
    } catch {
      return Promise.resolve(null);
    }
  }

  function finishActive(
    sessionId: string,
    state: SessionRequestState,
    active: ActiveRequest
  ): void {
    const current = inFlight.get(sessionId);
    if (current !== state || current.active !== active) return;

    const pending = state.pending;
    if (!pending) {
      inFlight.delete(sessionId);
      return;
    }
    state.pending = null;
    const next = startActive(state, pending.request, pending.generate);
    void next.then(pending.resolve);
  }

  function startActive(
    state: SessionRequestState | null,
    request: FollowUpRequest,
    generate: FollowUpGenerator
  ): Promise<SessionFollowUpSuggestion[] | null> {
    const active: ActiveRequest = {
      generation: request.generation,
      promise: execute(request, generate),
    };
    const nextState = state ?? { active, pending: null };
    nextState.active = active;
    inFlight.set(request.sessionId, nextState);
    void active.promise.then(() =>
      finishActive(request.sessionId, nextState, active)
    );
    return active.promise;
  }

  return {
    request(request, generate = invokeFollowUpGenerator) {
      const state = inFlight.get(request.sessionId);
      if (state) {
        if (state.active.generation === request.generation) {
          return state.active.promise;
        }
        if (state.pending?.request.generation === request.generation) {
          return state.pending.promise;
        }
        const latestGeneration =
          state.pending?.request.generation ?? state.active.generation;
        if (request.generation <= latestGeneration) {
          return Promise.resolve(null);
        }

        state.pending?.resolve(null);
        let resolvePending!: (
          suggestions: SessionFollowUpSuggestion[] | null
        ) => void;
        const pendingPromise = new Promise<SessionFollowUpSuggestion[] | null>(
          (resolve) => {
            resolvePending = resolve;
          }
        );
        state.pending = {
          request,
          generate,
          promise: pendingPromise,
          resolve: resolvePending,
        };
        return pendingPromise;
      }
      if (inFlight.size >= maxConcurrentSessions) {
        return Promise.resolve(null);
      }

      return startActive(null, request, generate);
    },
    inFlightCount: () => inFlight.size,
  };
}

const followUpRequestCoordinator = createFollowUpRequestCoordinator();

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function resolveWorkItemFollowUpScope({
  sessionId,
  inputAreaSessionId,
  session,
}: Omit<
  UseWorkItemFollowUpSuggestionsInput,
  "events"
>): WorkItemFollowUpScope | null {
  if (
    !session ||
    session.readOnly === true ||
    inputAreaSessionId !== sessionId ||
    session.session_id !== sessionId
  ) {
    return null;
  }
  const orgId = clean(session.orgId);
  const workItemId = clean(session.workItemId);
  if (!orgId || !workItemId) return null;
  return { sessionId, orgId, workItemId };
}

export function resolveFollowUpProviderIdentity(
  accountIdValue: string | null | undefined,
  modelValue: string | null | undefined
): FollowUpProviderIdentity | null {
  const accountId = clean(accountIdValue);
  const model = clean(modelValue);
  return accountId && model ? { accountId, model } : null;
}

function isConversationMessage(
  event: SessionEvent
): event is SessionEvent & { source: "user" | "assistant" } {
  return (
    event.displayVariant === "message" &&
    (event.source === "user" || event.source === "assistant") &&
    event.displayText.trim().length > 0
  );
}

export function selectFollowUpConversation(
  events: ReadonlyArray<SessionEvent>
): SessionFollowUpMessage[] {
  return events
    .filter(isConversationMessage)
    .slice(-FOLLOW_UP_CONTEXT_MESSAGES)
    .map((event) => ({
      role: event.source,
      content: event.displayText.trim(),
    }));
}

export function latestCompletedAssistantFingerprint(
  events: ReadonlyArray<SessionEvent>
): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event.source === "assistant" &&
      event.displayVariant === "message" &&
      event.displayStatus === "completed" &&
      event.displayText.trim()
    ) {
      return `${event.id}\0${event.displayText.trim()}`;
    }
  }
  return null;
}

export function initializeFollowUpLifecycleObservation(
  currentScopeKey: string,
  snapshot: FollowUpLifecycleSnapshot
): FollowUpLifecycleObservation {
  return {
    scopeKey: currentScopeKey,
    observedGeneration: snapshot.generation,
    observedWorkingGeneration:
      snapshot.phase === "working" ? snapshot.generation : null,
    assistantBaseline: snapshot.assistantFingerprint,
    handledTerminalGeneration:
      snapshot.phase === "idle"
        ? (snapshot.terminal?.generation ?? null)
        : null,
  };
}

export function advanceFollowUpLifecycleObservation(
  observation: FollowUpLifecycleObservation,
  snapshot: FollowUpLifecycleSnapshot,
  providerReady: boolean
): {
  observation: FollowUpLifecycleObservation;
  clear: boolean;
  generate: boolean;
} {
  if (snapshot.phase !== "idle") {
    const generationChanged =
      observation.observedGeneration !== snapshot.generation;
    const next = {
      ...observation,
      observedGeneration: snapshot.generation,
      observedWorkingGeneration:
        snapshot.phase === "working"
          ? snapshot.generation
          : generationChanged
            ? null
            : observation.observedWorkingGeneration,
      assistantBaseline: generationChanged
        ? snapshot.assistantFingerprint
        : observation.assistantBaseline,
    };
    return { observation: next, clear: true, generate: false };
  }

  const terminal = snapshot.terminal;
  if (!terminal) {
    return { observation, clear: false, generate: false };
  }
  if (!providerReady) {
    return {
      observation: {
        ...observation,
        handledTerminalGeneration: terminal.generation,
      },
      clear: false,
      generate: false,
    };
  }
  if (
    terminal.status !== "completed" ||
    terminal.generation !== observation.observedGeneration ||
    terminal.generation !== observation.observedWorkingGeneration ||
    terminal.generation === observation.handledTerminalGeneration ||
    !snapshot.assistantFingerprint ||
    snapshot.assistantFingerprint === observation.assistantBaseline
  ) {
    return { observation, clear: false, generate: false };
  }

  return {
    observation: {
      ...observation,
      handledTerminalGeneration: terminal.generation,
    },
    clear: false,
    generate: true,
  };
}

export function isFollowUpResultCurrent({
  requestEpoch,
  currentRequestEpoch,
  expectedContextKey,
  currentContextKey,
  phase,
  expectedGeneration,
  terminal,
}: FollowUpResultGuardInput): boolean {
  return (
    requestEpoch === currentRequestEpoch &&
    expectedContextKey === currentContextKey &&
    phase === "idle" &&
    terminal?.generation === expectedGeneration &&
    terminal.status === "completed"
  );
}

function scopeKey(scope: WorkItemFollowUpScope | null): string {
  return scope ? `${scope.sessionId}\0${scope.orgId}\0${scope.workItemId}` : "";
}

export function resolveEnabledFollowUpScope(
  enabled: boolean,
  scope: WorkItemFollowUpScope | null
): WorkItemFollowUpScope | null {
  return enabled ? scope : null;
}

/**
 * Observe the authoritative turn FSM and generate ephemeral next-step buttons
 * only for a newly completed turn. Existing terminal state is baselined on
 * mount/session switch, so opening historical chat never starts model work.
 */
export function useWorkItemFollowUpSuggestions({
  sessionId,
  inputAreaSessionId,
  session,
  events,
}: UseWorkItemFollowUpSuggestionsInput): WorkItemFollowUpSuggestionsState {
  const lifecycleSignal = useAtomValue(turnLifecycleSignalAtom);
  const followUpSuggestionsEnabled = useAtomValue(
    settingAtom("agent.sde.followUpSuggestionsEnabled")
  );
  const providerIdentity = useMemo(
    () => resolveFollowUpProviderIdentity(session?.accountId, session?.model),
    [session?.accountId, session?.model]
  );
  const scope = useMemo(
    () =>
      resolveWorkItemFollowUpScope({
        sessionId,
        inputAreaSessionId,
        session,
      }),
    [inputAreaSessionId, session, sessionId]
  );
  const completedAssistantFingerprint = useMemo(
    () => latestCompletedAssistantFingerprint(events),
    [events]
  );
  // Provider-backed suggestions are an explicit paid capability. Keeping the
  // disabled preference in the scope key also invalidates an in-flight result
  // immediately when the user turns the capability off.
  const enabledScope = resolveEnabledFollowUpScope(
    followUpSuggestionsEnabled,
    scope
  );
  const currentScopeKey = scopeKey(enabledScope);
  const requestContextKey = `${currentScopeKey}\0${providerIdentity?.accountId ?? ""}\0${providerIdentity?.model ?? ""}`;
  const requestContextKeyRef = useRef(requestContextKey);
  requestContextKeyRef.current = requestContextKey;
  const observationRef = useRef<FollowUpLifecycleObservation | null>(null);
  const requestEpochRef = useRef(0);
  const [suggestions, setSuggestions] = useState<SessionFollowUpSuggestion[]>(
    []
  );

  const clearSuggestions = useCallback(() => {
    requestEpochRef.current += 1;
    setSuggestions((current) => (current.length === 0 ? current : []));
  }, []);

  useEffect(() => {
    requestEpochRef.current += 1;
    setSuggestions([]);
    if (!enabledScope) {
      observationRef.current = null;
      return;
    }

    observationRef.current = initializeFollowUpLifecycleObservation(
      currentScopeKey,
      {
        phase: getTurnPhase(enabledScope.sessionId),
        generation: getTurnGeneration(enabledScope.sessionId),
        terminal: getLastTurnTerminal(enabledScope.sessionId),
        assistantFingerprint: completedAssistantFingerprint,
      }
    );
    // `events` is intentionally excluded: this effect defines the baseline for
    // a scope transition, not every streaming update inside that scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentScopeKey, requestContextKey]);

  useEffect(() => {
    if (!enabledScope) return;
    const observation = observationRef.current;
    if (!observation || observation.scopeKey !== currentScopeKey) return;

    const terminal = getLastTurnTerminal(enabledScope.sessionId);
    const documentVisible = document.visibilityState !== "hidden";
    const advanced = advanceFollowUpLifecycleObservation(
      observation,
      {
        phase: getTurnPhase(enabledScope.sessionId),
        generation: getTurnGeneration(enabledScope.sessionId),
        terminal,
        assistantFingerprint: completedAssistantFingerprint,
      },
      providerIdentity !== null && documentVisible
    );
    observationRef.current = advanced.observation;
    if (advanced.clear) {
      clearSuggestions();
      return;
    }
    if (!advanced.generate || !terminal || !providerIdentity) return;
    const messages = selectFollowUpConversation(events);
    if (
      messages.at(-1)?.role !== "assistant" ||
      !messages.some((message) => message.role === "user")
    ) {
      // The durable assistant message may land one React update after the FSM
      // terminal. Keep this generation unhandled so the events dependency can
      // retry once that owning-boundary data arrives.
      observationRef.current = observation;
      return;
    }

    const requestEpoch = ++requestEpochRef.current;
    const expectedContextKey = requestContextKey;
    void followUpRequestCoordinator
      .request({
        sessionId: enabledScope.sessionId,
        generation: terminal.generation,
        messages,
      })
      .then((nextSuggestions) => {
        const currentTerminal = getLastTurnTerminal(enabledScope.sessionId);
        if (
          !nextSuggestions ||
          !isFollowUpResultCurrent({
            requestEpoch,
            currentRequestEpoch: requestEpochRef.current,
            expectedContextKey,
            currentContextKey: requestContextKeyRef.current,
            phase: getTurnPhase(enabledScope.sessionId),
            expectedGeneration: terminal.generation,
            terminal: currentTerminal,
          })
        ) {
          return;
        }
        setSuggestions(nextSuggestions);
      });
    // `events` is intentionally represented by the completed assistant
    // fingerprint. Running stream deltas cannot make this pass eligible and
    // should not repeatedly execute the lifecycle effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    clearSuggestions,
    completedAssistantFingerprint,
    currentScopeKey,
    lifecycleSignal,
    providerIdentity,
    requestContextKey,
    enabledScope,
  ]);

  return { suggestions, clearSuggestions };
}
