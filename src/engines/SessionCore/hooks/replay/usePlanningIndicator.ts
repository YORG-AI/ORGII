/**
 * usePlanningIndicator Hook
 *
 * Shows a single "Planning next step..." line in the chat panel when:
 * 1. Any session type is actively working (code / cloud / OS agent)
 * 2. No store mutations for IDLE_THRESHOLD_MS (1 second)
 *
 * The indicator stays visible until new events arrive or the session ends.
 *
 * After PLANNING_SLOW_HINT_MS (10s) with the indicator still visible,
 * `showSlowHint` becomes true (e.g. "Taking longer than usual.") — UNLESS
 * the most recent chat-visible event is already a settled assistant message,
 * in which case the slow hint is suppressed. From the user's point of view
 * the agent has just finished talking; promoting the footer to "taking
 * longer than usual" while the turn executor is doing its post-batch
 * "anything else?" LLM round trip is misleading. The base indicator itself
 * is NOT suppressed in that state: mid-turn the agent routinely narrates
 * (settled assistant message) and then thinks for seconds before the next
 * tool call, and hiding the footer there reads as a frozen UI.
 *
 * Watchdog: if the indicator stays visible for PLANNING_WATCHDOG_MS (60s),
 * we assume Rust dropped `agent:complete` (or `agent:queue_status` idle)
 * and force `sessionRuntimeStatusAtom` to `completed` so the UI cannot stay
 * stuck on "Planning next step..." forever. Logged as a warning because
 * this should only fire on genuine event-loss bugs.
 *
 * Reads directly from derivedSnapshotAtom (NOT eventsAtom). During streaming,
 * Rust pushes StreamingSnapshot which has no `events` field, causing eventsAtom
 * to return []. Both snapshot types now carry `hasRunningEvent` (computed
 * against ALL events, including non-chat-visible ones like thinking deltas).
 * Running events are used only to keep the watchdog from force-completing a
 * legitimate long tool call; they do not suppress the idle footer.
 *
 * Uses snapshot `version` as the activity token — it bumps on every store
 * mutation (upsert, append, merge), including streaming deltas for thinking
 * and assistant messages. This avoids iterating chatEvents for text length.
 *
 * Cold-start optimisation: when isSessionActive first becomes true (e.g. the
 * user just sent a message and the agent has not produced its first event
 * yet), `idleAfterVersion` is seeded synchronously from `version` in a
 * useEffect with a stable activation ref, so the indicator is visible on
 * the very next paint without waiting IDLE_THRESHOLD_MS. Any subsequent
 * store mutation bumps `version`, breaking the equality and re-arming the
 * full 1-second delay to prevent flicker between tool calls. (An earlier
 * version used `setTimeout(0)` here, but that could race with the agent's
 * first event and leave the indicator hidden for several seconds on very
 * cold starts.)
 */
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef, useState } from "react";

import { eventStoreVersionAtom } from "@src/engines/SessionCore/core/atoms/events";
import { sessionIdAtom } from "@src/engines/SessionCore/core/atoms/metadata";
import {
  globalAnyRunningAtom,
  globalHasAwaitingUserInteractionAtom,
  globalLastIsSettledAssistantMessageAtom,
} from "@src/engines/SessionCore/derived/planningIndicatorAtoms";
import {
  noopSessionScopedPlanningMetaAtom,
  sessionScopedPlanningMetaAtomFamily,
} from "@src/engines/SessionCore/derived/sessionScopedChatEvents";
import { createLogger } from "@src/hooks/logger";
import {
  isPendingCancelAtom,
  isSessionActiveAtom,
  sessionRuntimeStatusAtom,
  setSessionRuntimeStatusAtom,
} from "@src/store/session/cliSessionStatusAtom";
import {
  hasLiveSubagentJobs,
  subagentJobMapAtom,
} from "@src/store/session/subagentJobAtom";

const log = createLogger("usePlanningIndicator");

/** How long (ms) to wait without new events before showing the indicator */
const IDLE_THRESHOLD_MS = 1000;

/** How long (ms) the planning indicator must stay visible before showing the slow hint */
const PLANNING_SLOW_HINT_MS = 10_000;

/**
 * How long (ms) the planning indicator may stay visible before the watchdog
 * force-completes the session. Generous because legitimate "LLM is wrapping
 * up after a tool batch" pauses can reach 10–20s on slow providers; anything
 * past a full minute almost certainly indicates a missed `agent:complete`.
 */
const PLANNING_WATCHDOG_MS = 60_000;

export interface PlanningIndicatorVisibilityInput {
  runtimeStatus: string;
  isSessionActive: boolean;
  isPendingCancel: boolean;
  hasAwaitingUserInteraction: boolean;
  anyRunning: boolean;
  coldStartVisible: boolean;
  idleAfterVersion: number | null;
  version: number;
  /**
   * True when the (global) session has a still-running background subagent.
   * The parent turn can mechanically end (runtimeStatus → idle) while a
   * `agent(background: true)` worker keeps running; without this the footer
   * would vanish during that gap even though work is clearly ongoing.
   */
  hasLiveSubagent: boolean;
}

export function shouldShowPlanningIndicator({
  runtimeStatus,
  isSessionActive,
  isPendingCancel,
  hasAwaitingUserInteraction,
  coldStartVisible,
  idleAfterVersion,
  version,
  hasLiveSubagent,
}: PlanningIndicatorVisibilityInput): boolean {
  const runtimeCanShowPlanning =
    runtimeStatus === "running" ||
    runtimeStatus === "installing" ||
    runtimeStatus === "waiting_for_user" ||
    runtimeStatus === "waiting_for_funds" ||
    hasLiveSubagent;
  return (
    runtimeCanShowPlanning &&
    isSessionActive &&
    !isPendingCancel &&
    !hasAwaitingUserInteraction &&
    (coldStartVisible || idleAfterVersion === version)
  );
}

export interface PlanningIndicatorState {
  /** 1 when the planning footer should show, 0 when hidden */
  count: 0 | 1;
  /** True after the indicator has been visible for PLANNING_SLOW_HINT_MS */
  showSlowHint: boolean;
  /**
   * Stable random index used by the footer to pick one phrasing variant
   * from the localized variant array. Re-rolled every time the indicator
   * transitions hidden → visible; stays fixed for the whole visible span
   * (including the slow-hint transition at 10s) so the text does not
   * shuffle mid-wait.
   */
  variantIndex: number;
}

/**
 * Session-scoped mode for `usePlanningIndicator`.
 *
 * The default (no scope) reads the GLOBAL active-session atoms
 * (`isSessionActiveAtom`, `sessionRuntimeStatusAtom`, `derivedSnapshotAtom`,
 * `eventStoreVersionAtom`) — correct for the primary ChatPanel only. A
 * session-scoped ChatHistory instance (subagent monitor cell) must pass a
 * scope so the footer is driven by ITS session's snapshot channel instead
 * of the parent's.
 *
 * `isLive` is supplied by the surface because subagent sessions are not in
 * the global sidebar session map — the monitor strip already holds the
 * backend-authoritative status (`es_get_child_sessions` → endedAt). The
 * caller should also fold replay state into it (a scrubbed cell shows a
 * historical slice; a footer there would lie).
 */
export interface PlanningIndicatorScope {
  sessionId: string;
  isLive: boolean;
}

export function usePlanningIndicator(
  scope?: PlanningIndicatorScope | null
): PlanningIndicatorState {
  const scoped = Boolean(scope);
  const globalIsSessionActive = useAtomValue(isSessionActiveAtom);
  const globalIsPendingCancel = useAtomValue(isPendingCancelAtom);
  const globalRuntimeStatus = useAtomValue(sessionRuntimeStatusAtom);
  const globalVersion = useAtomValue(eventStoreVersionAtom);
  const sessionId = useAtomValue(sessionIdAtom);
  const subagentJobMap = useAtomValue(subagentJobMapAtom);
  const setSessionRuntimeStatus = useSetAtom(setSessionRuntimeStatusAtom);
  const scopedMeta = useAtomValue(
    scope
      ? sessionScopedPlanningMetaAtomFamily(scope.sessionId)
      : noopSessionScopedPlanningMetaAtom
  );

  const isSessionActive = scoped
    ? Boolean(scope?.isLive)
    : globalIsSessionActive;
  const isPendingCancel = scoped ? false : globalIsPendingCancel;
  // Scoped surfaces have no runtime-status mirror of their own; liveness is
  // already folded into `isLive`, so map it onto the status gate directly.
  const runtimeStatus = scoped
    ? scope?.isLive
      ? "running"
      : "idle"
    : globalRuntimeStatus;
  const version = scoped ? scopedMeta.version : globalVersion;

  // Derived atoms only notify when the boolean flips, not on every token.
  // Scoped surfaces use scopedMeta instead of the global atoms.
  const globalAnyRunning = useAtomValue(globalAnyRunningAtom);
  const anyRunning = scoped ? scopedMeta.anyRunning : globalAnyRunning;

  const globalHasAwaitingUserInteraction = useAtomValue(
    globalHasAwaitingUserInteractionAtom
  );
  const hasAwaitingUserInteraction = scoped
    ? scopedMeta.hasAwaitingUserInteraction
    : globalHasAwaitingUserInteraction;

  // True when the most recent chat-visible event is a non-streaming
  // assistant message that has already settled. In this state the user
  // has seen the final reply, so showing a planning footer is misleading
  // even if the backend terminal event is still winding down.
  // The derived atom only fires when the value actually changes, not every token.
  const globalLastIsSettledAssistantMessage = useAtomValue(
    globalLastIsSettledAssistantMessageAtom
  );
  const lastIsSettledAssistantMessage = scoped
    ? false
    : globalLastIsSettledAssistantMessage;

  const [idleAfterVersion, setIdleAfterVersion] = useState<number | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Version at the moment isSessionActive first became true. Lives in
  // state (not a ref) so the render that seeds it also re-evaluates
  // `coldStartVisible`; with a ref, the first post-activation render
  // would still see `null` and the indicator would not appear until the
  // next version bump or IDLE_THRESHOLD_MS.
  const [activationVersion, setActivationVersion] = useState<number | null>(
    null
  );

  useEffect(() => {
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }

    let cancelled = false;

    if (!isSessionActive) {
      // Session ended — clear both activation and idle trackers so the
      // indicator cannot briefly re-appear if an in-flight 1-second idle
      // timer fires after isSessionActive flips to false. Both setStates use
      // queueMicrotask to satisfy react-hooks/set-state-in-effect
      // while still landing on the very next paint.
      queueMicrotask(() => {
        if (!cancelled) {
          setActivationVersion(null);
          setIdleAfterVersion(null);
        }
      });
      return () => {
        cancelled = true;
      };
    }

    if (activationVersion === null) {
      // Cold-start: first render where isSessionActive flipped to true.
      // Record the version at activation so `coldStartVisible` below
      // goes true on the next render, without waiting IDLE_THRESHOLD_MS.
      // queueMicrotask defers the setState past the effect body to satisfy
      // react-hooks/set-state-in-effect while still landing on the very
      // next paint (same frame), which is what makes cold-start visible.
      queueMicrotask(() => {
        if (!cancelled) setActivationVersion(version);
      });
      return () => {
        cancelled = true;
      };
    }

    // Warm path: something just mutated the store (tool call finished,
    // delta chunk arrived, etc.). Wait the full IDLE_THRESHOLD_MS before
    // declaring idle, so the indicator doesn't flicker between tools.
    idleTimerRef.current = setTimeout(() => {
      setIdleAfterVersion(version);
    }, IDLE_THRESHOLD_MS);

    return () => {
      cancelled = true;
      if (idleTimerRef.current) {
        clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
    };
  }, [isSessionActive, version, activationVersion]);

  // Visible when: session active, not pending cancel, AND either
  //   (a) cold-start — version hasn't bumped since activation yet, OR
  //   (b) warm — IDLE_THRESHOLD_MS elapsed since last mutation.
  //
  // isPendingCancel guard: the user pressed Stop but Rust hasn't confirmed
  // agent:complete yet. During this window streamRetryStatusAtom may have
  // already cleared (reconnect pill gone) while sessionRuntimeStatus is still
  // "running" — showing "Planning…" here is misleading and confusing.
  // hasAwaitingUserInteraction guard: blocking interaction tools keep the
  // session active while waiting for a click. That is not planning.
  const coldStartVisible =
    activationVersion !== null && activationVersion === version;
  // Scoped surfaces (subagent monitor cell) fold liveness into `isLive`
  // already; the live-subagent gap only applies to the global composer.
  const hasLiveSubagent = scoped
    ? false
    : hasLiveSubagentJobs(subagentJobMap, sessionId);
  const visible = shouldShowPlanningIndicator({
    runtimeStatus,
    isSessionActive,
    isPendingCancel,
    hasAwaitingUserInteraction,
    anyRunning,
    coldStartVisible,
    idleAfterVersion,
    version,
    hasLiveSubagent,
  });

  const [showSlowHint, setShowSlowHint] = useState(false);

  useEffect(() => {
    if (!visible) {
      return;
    }
    const timerId = window.setTimeout(() => {
      setShowSlowHint(true);
    }, PLANNING_SLOW_HINT_MS);
    return () => {
      window.clearTimeout(timerId);
      setShowSlowHint(false);
    };
  }, [visible]);

  // Watchdog: force-complete the session if the planning indicator stays
  // visible past PLANNING_WATCHDOG_MS. Any new store mutation flips
  // `visible` to false (via the idle-timer arm in the effect above),
  // which cancels this timer; on the next idle the watchdog re-arms.
  // We only trip on genuine "no activity at all" stalls.
  //
  // UI-only: this clears the runtime-status mirror so the footer stops
  // saying "Planning…", but deliberately does NOT touch the turn-lifecycle
  // FSM. A long quiet stretch (subagent wait, slow tool) is not proof the
  // turn ended, and a synthetic terminal here released the message queue
  // mid-turn (queued follow-ups were auto-sent into a still-running turn).
  // If Rust genuinely dropped agent:complete, the queue's backend status
  // gate re-checks and drains once the session row reads terminal.
  //
  // Scoped instances skip the watchdog entirely: they don't own the global
  // runtime-status mirror, and their liveness comes from the monitor
  // strip's backend-authoritative status, which self-corrects.
  //
  // hasLiveSubagent guard: when a background subagent is still running the
  // footer is legitimately visible for as long as the child takes (often
  // minutes). Tripping the watchdog there would spam the warning and force
  // the parent status to "completed" mid-wait — the child's
  // `agent:subagent_job_changed` terminal event is the real completion
  // signal, not a 60s wall clock.
  useEffect(() => {
    if (scoped || !visible || !sessionId || hasLiveSubagent || anyRunning)
      return;
    const timerId = window.setTimeout(() => {
      log.warn(
        `[usePlanningIndicator] watchdog: planning indicator stuck for ${PLANNING_WATCHDOG_MS}ms — ` +
          "forcing session status to 'completed'. This usually means Rust dropped agent:complete " +
          "or the idle agent:queue_status frame."
      );
      setSessionRuntimeStatus({
        sessionId,
        status: "completed",
        source: "planning",
      });
    }, PLANNING_WATCHDOG_MS);
    return () => {
      window.clearTimeout(timerId);
    };
  }, [
    scoped,
    visible,
    sessionId,
    hasLiveSubagent,
    anyRunning,
    setSessionRuntimeStatus,
  ]);

  // Re-roll the variant index on every hidden → visible transition.
  // Using a large random integer and letting the consumer mod by the
  // variant array length keeps this decoupled from the locale data.
  // The roll is scheduled via queueMicrotask so the setState call is not
  // synchronous within the effect body (lint: react-hooks/set-state-in-effect).
  const [variantIndex, setVariantIndex] = useState(0);
  const wasVisibleRef = useRef(false);
  useEffect(() => {
    const becameVisible = visible && !wasVisibleRef.current;
    wasVisibleRef.current = visible;
    if (!becameVisible) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setVariantIndex(Math.floor(Math.random() * 1_000_000));
    });
    return () => {
      cancelled = true;
    };
  }, [visible]);

  // Slow-hint suppression is derived (not gated inside the timer effect)
  // so that `useEffect` body stays pure — no synchronous setState inside
  // an effect, no extra schedule/clear cycle when the chat tail flips
  // between "settled assistant message" and "thinking again".
  return {
    count: visible ? 1 : 0,
    showSlowHint: visible && showSlowHint && !lastIsSettledAssistantMessage,
    variantIndex,
  };
}
