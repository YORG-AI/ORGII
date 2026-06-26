/**
 * Shared mode-switch logic used by both ModeSwitchEvent (chat history)
 * and ModeSwitchInputCard (input area).
 *
 * Provides:
 * - Resolved-event cache (so both components agree on which events are handled)
 * - MODE_LABELS lookup
 * - switchMode / skipMode action helpers
 */
import { respondModeSwitch } from "@src/api/tauri/agent";
import { cursorBridgeSetMode } from "@src/api/tauri/cursorBridge";
import { rpc } from "@src/api/tauri/rpc";
import type { AgentExecMode } from "@src/config/sessionCreatorConfig";
import {
  beginOptimisticTurn,
  failOptimisticTurn,
} from "@src/engines/SessionCore/control/optimisticTurnStatus";
import { eventsAtom } from "@src/engines/SessionCore/core/atoms";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import { SessionService } from "@src/engines/SessionCore/services/SessionService";
import { creatorDefaultModelSelectionAtom } from "@src/store/session/creatorDefaultModelAtom";
import { cursorModeOverrideAtomFamily } from "@src/store/session/cursorModeOverrideAtom";
import { sessionByIdAtom, upsertSession } from "@src/store/session/sessionAtom";
import { activeSessionIdAtom } from "@src/store/session/viewAtom";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";
import { resolveModelForMessage } from "@src/util/session/resolveModelForMessage";
import {
  composerIdFromSessionId,
  isAgentSession,
  isCursorIdeSession,
} from "@src/util/session/sessionDispatch";

// ============================================
// Resolved cache
// ============================================

export type ModeSwitchResolution = "switched" | "skipped";

const MAX_RESOLVED_CACHE = 200;
const resolvedEvents = new Map<string, ModeSwitchResolution>();

export function getResolution(
  eventId: string
): ModeSwitchResolution | undefined {
  return resolvedEvents.get(eventId);
}

export function isResolved(eventId: string): boolean {
  return resolvedEvents.has(eventId);
}

function markResolved(eventId: string, status: ModeSwitchResolution) {
  if (resolvedEvents.size >= MAX_RESOLVED_CACHE) {
    const firstKey = resolvedEvents.keys().next().value;
    if (firstKey) resolvedEvents.delete(firstKey);
  }
  resolvedEvents.set(eventId, status);
}

// ============================================
// Mode labels
// ============================================

export const MODE_LABELS: Record<string, string> = {
  build: "Build",
  ask: "Ask",
  plan: "Plan",
  debug: "Debug",
  review: "Review",
};

// ============================================
// Actions
// ============================================

async function markModeSwitchEventResolved(
  eventId: string,
  sessionId: string,
  resolution: ModeSwitchResolution,
  targetMode?: string
): Promise<void> {
  await eventStoreProxy.updateById(
    eventId,
    {
      displayStatus: "completed",
      activityStatus: "processed",
      result: {
        choice: resolution === "switched" ? "switch" : "skip",
        targetMode,
      },
    },
    sessionId
  );
}

function getLastUserText(sessionId: string): string {
  // Prefer the per-session snapshot cache so we always read the correct
  // session's events even when the global eventsAtom hasn't settled yet
  // (e.g. during a rapid session switch).
  const snap = eventStoreProxy.getLatestSessionSnapshot(sessionId);
  const events =
    snap && "events" in snap
      ? snap.events
      : // Fallback: read from the global atom — only safe when sessionId
        // matches the currently active session, but better than returning ""
        getInstrumentedStore().get(eventsAtom);
  for (let idx = events.length - 1; idx >= 0; idx--) {
    if (events[idx].source === "user" && events[idx].displayText) {
      return events[idx].displayText;
    }
  }
  return "";
}

async function switchCursorIdeMode(
  eventId: string,
  sessionId: string,
  targetMode: string
): Promise<void> {
  const composerId = composerIdFromSessionId(sessionId);
  // Bug-fix: must mark the event resolved even when composerId is missing,
  // otherwise the chat history event stays stuck at awaiting_user forever
  // while the module cache considers it resolved and suppresses the card.
  await markModeSwitchEventResolved(eventId, sessionId, "switched", targetMode);
  if (!composerId) return;

  const store = getInstrumentedStore();
  store.set(cursorModeOverrideAtomFamily(sessionId), targetMode);
  await cursorBridgeSetMode({ agentId: composerId, modeId: targetMode });

  const lastUserText = getLastUserText(sessionId);
  // Only skip the resend when there is no prior user message to anchor on.
  // A loop is impossible by construction: every read-only mode (Plan, Ask,
  // Debug, Review) denies `suggest_mode_switch` via `read_only_deny_base`,
  // so the tool is absent from the LLM's toolset after the switch and cannot
  // re-trigger another mode-switch.
  if (!lastUserText) return;

  // No beginOptimisticTurn here: Cursor IDE sessions have no turn lifecycle
  // (the CDP stream emits no terminal event), so an optimistic `running`
  // would never be cleared — the same reason useMessageDispatch closes the
  // turn immediately after a successful cursor handoff.
  await SessionService.sendMessage({
    sessionId,
    content: lastUserText,
    mode: targetMode,
  });
}

async function switchAgentMode(
  eventId: string,
  sessionId: string,
  targetMode: string
): Promise<void> {
  await markModeSwitchEventResolved(eventId, sessionId, "switched", targetMode);

  const store = getInstrumentedStore();

  // Persist the new mode on the session row instead of the global
  // creator-default atom — otherwise switching plan→build for one
  // session would silently change the default for every new session
  // the user creates afterwards. Optimistic upsert so the ModePill
  // and mode-aware UI repaint on the same frame.
  const sessionBefore = store.get(sessionByIdAtom(sessionId));
  if (sessionBefore?.agentExecMode !== targetMode) {
    if (sessionBefore) {
      upsertSession({
        ...sessionBefore,
        agentExecMode: targetMode as AgentExecMode,
      });
    }
    await rpc.sessionAggregate.patch({
      sessionId,
      patch: { agentExecMode: targetMode },
    });
  }

  await respondModeSwitch(sessionId, "switch", targetMode);

  const lastUserText = getLastUserText(sessionId);
  // Only skip the resume when there is no prior user message to anchor the
  // re-run on. We deliberately do NOT inspect the message text: a user's real
  // task can legitimately open with switch-style wording (e.g. "切模式检查…
  // 写个修复 plan 给我"), and dropping the resume in that case strands the turn
  // — the round flips to Plan but the agent never continues (the reported bug).
  // An infinite switch loop is impossible by construction: every read-only mode
  // (Plan, Ask, Debug, Review) denies `suggest_mode_switch` via
  // `read_only_deny_base`, so the tool is absent from the LLM's toolset after
  // the switch and cannot re-trigger another mode-switch.
  if (!lastUserText) return;

  // Re-run the SAME request under the new mode WITHOUT persisting a new
  // visible user message. The frontend groups chat history into rounds by
  // user-message boundary (`useChatGroups`), so re-sending `lastUserText`
  // here would open a brand-new round and duplicate the user bubble (GH #91).
  // Instead we use Resume semantics: `content=""` + `isResume=true` makes the
  // backend skip the `save_user_msg` write (see `should_save_user_msg` in
  // `turn/processor/mod.rs`) and anchor the turn on the still-present last
  // user row — so the new-mode run stays inside the original round.
  const sessionForSend = store.get(sessionByIdAtom(sessionId));
  const fallback = store.get(creatorDefaultModelSelectionAtom);
  const lastModelSelection = sessionForSend?.model
    ? {
        ...fallback,
        keySource: sessionForSend.keySource ?? fallback?.keySource,
        model: sessionForSend.model,
        selectedAccountId:
          sessionForSend.accountId ?? fallback?.selectedAccountId,
        cliAgentType: sessionForSend.cliAgentType ?? fallback?.cliAgentType,
        tier: sessionForSend.tier ?? fallback?.tier,
      }
    : fallback;
  const { model, accountId } = resolveModelForMessage(lastModelSelection);

  // Mode-switch re-runs bypass useMessageDispatch, so set the optimistic
  // running status here (P3).
  beginOptimisticTurn(sessionId);

  try {
    await SessionService.sendMessage({
      sessionId,
      content: "",
      isResume: true,
      model,
      accountId,
      mode: targetMode,
    });
  } catch (error) {
    failOptimisticTurn(sessionId);
    throw error;
  }
}

function isE2EModeSwitchMockEnabled(): boolean {
  return (
    typeof window !== "undefined" &&
    window.__ORGII_E2E_MODE_SWITCH_MOCK__ === true
  );
}

export async function switchMode(
  eventId: string,
  targetMode: string
): Promise<void> {
  const store = getInstrumentedStore();
  const sessionId = store.get(activeSessionIdAtom);
  if (!sessionId) return;

  markResolved(eventId, "switched");

  if (isE2EModeSwitchMockEnabled()) {
    await markModeSwitchEventResolved(
      eventId,
      sessionId,
      "switched",
      targetMode
    );
    const sessionBefore = store.get(sessionByIdAtom(sessionId));
    if (sessionBefore) {
      upsertSession({
        ...sessionBefore,
        agentExecMode: targetMode as AgentExecMode,
      });
    }
    return;
  }

  if (isCursorIdeSession(sessionId)) {
    await switchCursorIdeMode(eventId, sessionId, targetMode);
    return;
  }

  if (isAgentSession(sessionId)) {
    await switchAgentMode(eventId, sessionId, targetMode);
  }
}

export async function skipMode(eventId: string): Promise<void> {
  const store = getInstrumentedStore();
  const sessionId = store.get(activeSessionIdAtom);
  if (!sessionId) return;

  markResolved(eventId, "skipped");
  await markModeSwitchEventResolved(eventId, sessionId, "skipped");

  if (isAgentSession(sessionId)) {
    await respondModeSwitch(sessionId, "skip");
  }
}
