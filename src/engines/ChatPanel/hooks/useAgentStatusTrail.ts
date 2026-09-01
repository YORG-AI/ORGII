/**
 * useAgentStatusTrail
 *
 * Assembles the status trail that closes the conversation: while a round runs,
 * how long it has been going; between rounds, a resting phase so the
 * transcript still ends with the agent's own mark instead of simply stopping,
 * plus any background work that outlived the round.
 *
 * It is a derived view only — it owns no canonical state and is safe to
 * mount and unmount freely. Every input already exists:
 *
 *   - phase    — the SESSION's own status, read through the same helpers the
 *     sidebar row uses (`isSessionInProgress`, `isSessionPendingAsking`) and
 *     combined in the same order (`resolveTrailPhase`). Liveness itself goes
 *     through `resolveTailTurnAgentWorking`, so the trail, the tail-turn
 *     collapse phase, and the sidebar dot all read one rule: the foreground
 *     runtime atom for a native session, the persisted status for an
 *     external-history one.
 *   - elapsed  — anchored to the tail turn's start (`ChatGroupMeta.startMs`),
 *     the same instant `TurnCollapsePinBar` measures from once the round
 *     ends, so the live trail and the finished "Agent worked for X" bar
 *     always agree. Anchoring to a real event timestamp (rather than to when
 *     this hook happened to mount) keeps the count correct across session
 *     switches, remounts, and virtualization. Only the anchor is returned:
 *     `AgentStatusTrail` runs the per-second clock itself, so the ticking
 *     value never travels through `ChatHistoryList`'s memoized props.
 *   - tasks    — the same running shell processes and subagent workers that
 *     `ActiveProcesses` lists in the composer.
 *   - refresh  — for an imported transcript, `DataSourceConfig.lastScannedAt`
 *     for that session's source: the same timestamp the Runtime scanning
 *     panel shows, written by every importer run and by the sidebar's
 *     Rescan. ORGII does not run those agents, so it reports when it last
 *     looked rather than asserting they are idle.
 *
 * The pure formatting and precedence rules live in `agentStatusTrailMath.ts`.
 */
import { useAtomValue } from "jotai";
import { useEffect, useMemo, useState } from "react";

import { resolveTailTurnAgentWorking } from "@src/engines/ChatPanel/ChatHistory/hooks/useTailTurnCollapse";
import { isSessionActiveAtom } from "@src/store/session/cliSessionStatusAtom";
import {
  dataSourceConfigAtom,
  getSourceConfig,
} from "@src/store/session/dataSourceConfigAtom";
import { sessionByIdAtom } from "@src/store/session/sessionAtom";
import { shellProcessMapAtom } from "@src/store/session/shellProcessAtom";
import { subagentJobMapAtom } from "@src/store/session/subagentJobAtom";
import { isImportedHistorySession } from "@src/util/session/sessionDispatch";
import { resolveSessionDisplayMetadata } from "@src/util/session/sessionDisplayMetadata";
import { isSessionPendingAsking } from "@src/util/session/sessionStatusDot";

import {
  type AgentStatusTrailState,
  HIDDEN_AGENT_STATUS_TRAIL_STATE,
  resolveTrailPhase,
  resolveTrailStaleDelayMs,
} from "./agentStatusTrailMath";

export type {
  AgentStatusTrailPhase,
  AgentStatusTrailState,
} from "./agentStatusTrailMath";

export interface UseAgentStatusTrailOptions {
  /** Session the trail describes. `null` keeps it idle. */
  sessionId: string | null;
  /** Epoch ms of the running turn's user message; `null` hides the duration. */
  turnStartedAtMs: number | null;
  /**
   * Epoch ms of the newest event in the transcript. Once it is older than
   * `TRAIL_IDLE_AFTER_MS` the trail stops reading as running, whatever the
   * session status claims. `null` (nothing timestamped) is treated as "not
   * stale" — an absent timestamp is not evidence of silence.
   */
  lastActivityAtMs: number | null;
  /**
   * False on surfaces that must not carry a live readout at all — a
   * paginated history page that is not the final round. The trail is
   * `hidden` there, not merely idle.
   */
  enabled: boolean;
  /**
   * Liveness of a session-SCOPED surface — a subagent monitor cell, or a
   * conversation whose member turn runs in an invisible one-shot runner.
   * `null` means this surface mirrors the globally-active session, so the
   * session's own status is authoritative instead. Same split
   * `usePlanningIndicator` makes with `PlanningIndicatorScope.isLive`:
   * a scoped session has no sidebar row and no entry in the global runtime
   * atom, so the surface that mounted it is the only thing that knows.
   */
  scopedIsLive: boolean | null;
}

export function useAgentStatusTrail({
  sessionId,
  turnStartedAtMs,
  lastActivityAtMs,
  enabled,
  scopedIsLive,
}: UseAgentStatusTrailOptions): AgentStatusTrailState {
  const foregroundAgentWorking = useAtomValue(isSessionActiveAtom);
  const session = useAtomValue(sessionByIdAtom(sessionId ?? ""));
  const processMap = useAtomValue(shellProcessMapAtom);
  const subagentJobMap = useAtomValue(subagentJobMapAtom);
  const dataSourceConfig = useAtomValue(dataSourceConfigAtom);

  const scoped = scopedIsLive !== null;
  const inProgress = scoped
    ? scopedIsLive
    : resolveTailTurnAgentWorking({
        activeId: sessionId,
        isAgentWorking: foregroundAgentWorking,
        sessionStatus: session?.status,
      });
  // A scoped session has no sidebar row to agree with, and its surface
  // reports only liveness — there is no "parked on a question" signal there.
  const pendingAsking =
    !scoped && session !== undefined && isSessionPendingAsking(session);
  // ONE timer armed for the remainder of the quiet window, re-armed whenever
  // activity moves — not a poll. Written only from the timeout callback so
  // the render below stays pure, the same discipline `useTailTurnPhase` uses
  // for its own stale latch.
  const [staleKey, setStaleKey] = useState<string | null>(null);
  const activityKey =
    sessionId !== null && lastActivityAtMs !== null
      ? `${sessionId}:${lastActivityAtMs}`
      : null;

  useEffect(() => {
    if (activityKey === null || lastActivityAtMs === null) return;

    const timeoutId = window.setTimeout(
      () => setStaleKey(activityKey),
      resolveTrailStaleDelayMs(lastActivityAtMs, Date.now())
    );

    return () => window.clearTimeout(timeoutId);
  }, [activityKey, lastActivityAtMs]);

  const stale = activityKey !== null && staleKey === activityKey;
  const phase = resolveTrailPhase({
    enabled,
    hasSession: sessionId !== null,
    inProgress,
    pendingAsking,
    stale,
  });
  const visible = phase !== "hidden";

  const isExternal = isImportedHistorySession(sessionId);
  // `resolveSessionDisplayMetadata` is the same projection the sidebar row
  // and the chat tab use to identify a session's source, and it resolves the
  // descriptor from the id prefix alone — so this works before the Session
  // object has landed in the map.
  const lastRefreshedAtMs = useMemo(() => {
    if (!isExternal || !sessionId) return null;
    const sourceId = resolveSessionDisplayMetadata({
      kind: "local",
      session: { session_id: sessionId, importedFrom: session?.importedFrom },
    }).externalSource?.sourceId;
    if (!sourceId) return null;
    return getSourceConfig(dataSourceConfig, sourceId).lastScannedAt;
  }, [isExternal, sessionId, session?.importedFrom, dataSourceConfig]);

  // Counted in the idle phase too: a `background` shell outlives the round
  // that started it, and a trail that said only "Agent is idle" while two
  // shells were still alive would be wrong.
  const runningTasks = useMemo(() => {
    if (!visible || !sessionId) return 0;
    let count = 0;
    const processes = processMap.get(sessionId);
    if (processes) {
      for (const process of processes.values()) {
        if (process.status === "running" || process.status === "background") {
          count++;
        }
      }
    }
    const jobs = subagentJobMap.get(sessionId);
    if (jobs) {
      for (const job of jobs.values()) {
        if (job.status === "running") count++;
      }
    }
    return count;
  }, [visible, sessionId, processMap, subagentJobMap]);

  return useMemo<AgentStatusTrailState>(() => {
    if (phase === "hidden") return HIDDEN_AGENT_STATUS_TRAIL_STATE;
    if (phase !== "running") {
      // The elapsed and token readouts belong to a round in flight. Keeping
      // the last round's numbers frozen on screen would read as live.
      return {
        phase,
        startedAtMs: null,
        runningTasks,
        isExternal,
        lastRefreshedAtMs,
      };
    }
    return {
      phase,
      startedAtMs: turnStartedAtMs,
      runningTasks,
      isExternal,
      lastRefreshedAtMs,
    };
  }, [phase, turnStartedAtMs, runningTasks, isExternal, lastRefreshedAtMs]);
}
