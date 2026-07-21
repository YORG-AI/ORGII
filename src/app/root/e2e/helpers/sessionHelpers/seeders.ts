import { invoke } from "@tauri-apps/api/core";

import { getOrgtrackSessionFinalDiffs } from "@src/api/tauri/lineage";
import { loadSessionAtom, sessionIdAtom } from "@src/engines/SessionCore";
import { navigateToEventAtom } from "@src/engines/SessionCore/core/atoms";
import { derivedSnapshotAtom } from "@src/engines/SessionCore/core/atoms/events";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { AppType } from "@src/engines/Simulator/types/appTypes";
import {
  openOrFocusSessionInChatPanelTabAtom,
  openWorkManagementChatPanelTabAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import {
  isPendingCancelAtom,
  lastUserMessageAtom,
  sessionRuntimeStatusAtom,
} from "@src/store/session/cliSessionStatusAtom";
import {
  pendingPlanApprovalsAtom,
  upsertPendingPlanApproval,
} from "@src/store/session/planApprovalAtom";
import {
  type Session,
  sessionsAtom,
  upsertSession,
} from "@src/store/session/sessionAtom";
import { updateShellProcessAtom } from "@src/store/session/shellProcessAtom";
import { updateSubagentJobAtom } from "@src/store/session/subagentJobAtom";
import {
  activeSessionIdAtom,
  openSessionAtom,
  workstationActiveSessionIdAtom,
} from "@src/store/session/viewAtom";
import {
  chatPanelMaximizedAtom,
  chatWidthAtom,
} from "@src/store/ui/chatPanelAtom";
import {
  simulatorFollowAppLockAtom,
  simulatorSelectedAppAtom,
  stationModeAtom,
} from "@src/store/ui/simulatorAtom";

import { asError } from "../../result";
import type { E2EStore, Json, Result } from "../../types";
import { waitForSessionSurface } from "./waitForSessionSurface";

export function createSessionSeederHelpers(store: E2EStore) {
  const seedChatEvents = async (
    sessionId: string,
    events: Json[],
    options?: {
      chatPanelMaximized?: boolean;
      chatWidth?: number;
      currentEventId?: string;
      runtimeStatus?:
        | "idle"
        | "running"
        | "installing"
        | "waiting_for_user"
        | "waiting_for_funds";
      stationMode?: "my-station" | "agent-station";
      selectedApp?: "CODE_EDITOR" | "CHANNELS";
      lastUserMessage?: { displayContent: string; imageDataUrls?: string[] };
    }
  ): Promise<Result<{ eventCount: number; chatEventCount: number }>> => {
    try {
      if (!sessionId) {
        return { ok: false, error: "seedChatEvents: `sessionId` is required" };
      }
      const sessionEvents = events as unknown as SessionEvent[];
      store.set(stationModeAtom, options?.stationMode ?? "my-station");
      store.set(chatPanelMaximizedAtom, options?.chatPanelMaximized ?? true);
      store.set(chatWidthAtom, options?.chatWidth ?? 560);
      store.set(activeSessionIdAtom, sessionId);
      store.set(workstationActiveSessionIdAtom, sessionId);
      await waitForSessionSurface(sessionId);
      await eventStoreProxy.set(sessionEvents, sessionId);
      store.set(loadSessionAtom, { sessionId, events: sessionEvents });

      await new Promise((resolve) => window.setTimeout(resolve, 100));
      await eventStoreProxy.set(sessionEvents, sessionId);
      store.set(loadSessionAtom, { sessionId, events: sessionEvents });
      // Persist like production writes do: the cloud push engine reads the
      // SQLite cache (getPersistedEvents), and a memory-only seed made it
      // observe an EMPTY session, mark the event plane clean, and never
      // ship segments (metadata-only rows with events_epoch=0 server-side).
      await eventStoreProxy.saveToCache(sessionId);

      const snapshot = await eventStoreProxy.getSnapshot(sessionId);
      store.set(derivedSnapshotAtom, snapshot);
      // Session hydration may restore its persisted layout while the seed is
      // being applied. Re-apply the requested deterministic layout after the
      // final load so rendered E2E assertions never inspect a zero-width
      // Agent Station hidden behind a maximized chat panel.
      store.set(stationModeAtom, options?.stationMode ?? "my-station");
      store.set(chatPanelMaximizedAtom, options?.chatPanelMaximized ?? true);
      store.set(chatWidthAtom, options?.chatWidth ?? 560);
      if (options?.runtimeStatus) {
        store.set(sessionRuntimeStatusAtom, options.runtimeStatus);
      }
      if (options?.lastUserMessage) {
        store.set(lastUserMessageAtom, {
          sessionId,
          displayContent: options.lastUserMessage.displayContent,
          imageDataUrls: options.lastUserMessage.imageDataUrls,
        });
      }
      if (options?.selectedApp === "CODE_EDITOR") {
        store.set(simulatorSelectedAppAtom, AppType.CODE_EDITOR);
        store.set(simulatorFollowAppLockAtom, AppType.CODE_EDITOR);
      } else if (options?.selectedApp === "CHANNELS") {
        store.set(simulatorSelectedAppAtom, AppType.CHANNELS);
        store.set(simulatorFollowAppLockAtom, AppType.CHANNELS);
      } else {
        store.set(simulatorSelectedAppAtom, null);
        store.set(simulatorFollowAppLockAtom, null);
      }
      if (options?.currentEventId) {
        store.set(navigateToEventAtom, options.currentEventId);
      }
      // resetToNewSession leaves the Launchpad/Work Management pill active.
      // Seeded transcript scenarios need the canonical session pill active;
      // otherwise that fullscreen tab immediately re-maximizes ChatPanel and
      // makes Agent Station zero-width after this helper returns.
      store.set(openOrFocusSessionInChatPanelTabAtom, {
        sessionId,
        sessionName: sessionId,
      });
      // `loadSessionAtom` fans out through React effects that can finish one
      // or two frames after the synchronous atom write. Let those settle,
      // then make the requested E2E layout authoritative one final time.
      await new Promise((resolve) => window.setTimeout(resolve, 100));
      store.set(stationModeAtom, options?.stationMode ?? "my-station");
      store.set(chatPanelMaximizedAtom, options?.chatPanelMaximized ?? true);
      store.set(chatWidthAtom, options?.chatWidth ?? 560);
      return {
        ok: true,
        eventCount: snapshot.eventCount,
        chatEventCount: snapshot.chatEvents.length,
      };
    } catch (err) {
      return asError(err);
    }
  };

  /**
   * Seed a bare session row into the sidebar list (`sessionsAtom`) without
   * opening it or touching the event store. Used by specs that exercise the
   * REAL rendered sidebar-row click path (e.g. "My Station follows the
   * active session's repo") — the spec performs the click; this only makes
   * the row exist with a deterministic `repoPath`.
   */
  const seedSidebarSession = async (input: {
    sessionId: string;
    name?: string;
    repoPath?: string;
    status?: string;
    orgId?: string;
    touchedFiles?: string[];
  }): Promise<Result<{ sessionId: string }>> => {
    try {
      if (!input.sessionId) {
        return {
          ok: false,
          error: "seedSidebarSession: `sessionId` is required",
        };
      }
      const now = new Date().toISOString();
      const existing = store
        .get(sessionsAtom)
        .find((candidate) => candidate.session_id === input.sessionId);
      const session: Session = {
        ...(existing ?? {}),
        session_id: input.sessionId,
        status: input.status ?? existing?.status ?? "completed",
        created_at: existing?.created_at ?? now,
        updated_at: now,
        name: input.name ?? existing?.name ?? input.sessionId,
        user_input: input.name ?? existing?.user_input ?? input.sessionId,
        repoPath: input.repoPath ?? existing?.repoPath,
        orgId: input.orgId ?? existing?.orgId,
        touchedFiles: input.touchedFiles ?? existing?.touchedFiles,
        filesChanged:
          input.touchedFiles?.length ?? existing?.filesChanged ?? undefined,
        category: existing?.category ?? "rust_agent",
        is_active: true,
      };
      upsertSession(session);
      return { ok: true, sessionId: input.sessionId };
    } catch (err) {
      return asError(err);
    }
  };

  const openWorkManagementTab = async (): Promise<
    Result<{ tabId: string }>
  > => {
    try {
      const tabId = store.set(openWorkManagementChatPanelTabAtom, {});
      return { ok: true, tabId };
    } catch (err) {
      return asError(err);
    }
  };

  const seedModeSwitchSession = async (input: {
    sessionId?: string;
    repoPath?: string;
    userText: string;
    reason?: string;
    targetMode?: string;
  }): Promise<Result<{ sessionId: string; eventId: string }>> => {
    try {
      const now = new Date().toISOString();
      const sessionId =
        input.sessionId ?? `sdeagent-e2e-mode-switch-${Date.now()}`;
      const switchEventId = `${sessionId}-suggest-mode-switch`;
      const existingSession = store
        .get(sessionsAtom)
        .find((candidate) => candidate.session_id === sessionId);
      const session: Session = existingSession ?? {
        session_id: sessionId,
        status: "idle",
        created_at: now,
        updated_at: now,
        user_input: input.userText,
        name: input.userText.slice(0, 80),
        repoPath: input.repoPath,
        category: "rust_agent",
        agentDefinitionId: "builtin:sde",
        agentDisplayName: "SDE Agent",
        agentExecMode: "build",
        model: "composer-2",
        is_active: true,
      };
      upsertSession(session);
      store.set(stationModeAtom, "my-station");
      store.set(chatPanelMaximizedAtom, true);
      store.set(chatWidthAtom, 560);
      store.set(openSessionAtom, {
        sessionId,
        sessionName: session.name,
        repoPath: input.repoPath,
      });
      store.set(sessionIdAtom, sessionId);
      store.set(sessionRuntimeStatusAtom, "idle");
      store.set(isPendingCancelAtom, false);
      await waitForSessionSurface(sessionId);

      const events: SessionEvent[] = [
        {
          chunk_id: null,
          id: `${sessionId}-user`,
          sessionId,
          createdAt: now,
          functionName: "user_message",
          uiCanonical: "user_message",
          actionType: "raw",
          args: {},
          result: { type: "user", message: input.userText },
          source: "user",
          displayText: input.userText,
          displayStatus: "completed",
          displayVariant: "message",
          activityStatus: "processed",
        },
        {
          chunk_id: null,
          id: switchEventId,
          sessionId,
          createdAt: now,
          functionName: "suggest_mode_switch",
          uiCanonical: "suggest_mode_switch",
          actionType: "tool_call",
          args: {
            target_mode: input.targetMode ?? "plan",
            reason:
              input.reason ??
              "This task should be planned before implementation.",
          },
          result: {},
          source: "assistant",
          displayText: "Switch to Plan mode",
          displayStatus: "awaiting_user",
          displayVariant: "tool_call",
          activityStatus: "pending",
          callId: switchEventId,
        },
      ];
      await eventStoreProxy.set(events, sessionId);
      store.set(loadSessionAtom, { sessionId, events });
      const snapshot = await eventStoreProxy.getSnapshot(sessionId);
      store.set(derivedSnapshotAtom, snapshot);
      await waitForSessionSurface(sessionId);
      return { ok: true, sessionId, eventId: switchEventId };
    } catch (err) {
      return asError(err);
    }
  };

  const seedPlanCard = async (input: {
    sessionId: string;
    title?: string;
    content: string;
  }): Promise<Result<{ planRevisionId: string }>> => {
    try {
      const planRevisionId = `${input.sessionId}-plan-revision`;
      const planId = `${input.sessionId}-plan`;
      const now = new Date().toISOString();
      const existing = await eventStoreProxy.getSnapshot(input.sessionId);
      const events: SessionEvent[] = [
        ...existing.events,
        {
          chunk_id: null,
          id: planRevisionId,
          sessionId: input.sessionId,
          createdAt: now,
          functionName: "plan_approval",
          uiCanonical: "plan_approval",
          actionType: "plan_approval",
          args: {
            title: input.title ?? "E2E Plan",
            content: input.content,
            planId,
            planRevisionId,
            originToolCallId: planRevisionId,
            planEventSource: "e2e",
            planPath: "/tmp/orgii-e2e-plan.md",
          },
          result: {
            status: "pending",
            planId,
            planRevisionId,
            planPath: "/tmp/orgii-e2e-plan.md",
          },
          source: "assistant",
          displayText: input.title ?? "E2E Plan",
          displayStatus: "awaiting_user",
          displayVariant: "tool_call",
          activityStatus: "agent",
          callId: planRevisionId,
        },
      ];
      store.set(pendingPlanApprovalsAtom, (prev) =>
        upsertPendingPlanApproval(prev, {
          sessionId: input.sessionId,
          planPath: "/tmp/orgii-e2e-plan.md",
          planTitle: input.title ?? "E2E Plan",
          planContent: input.content,
          toolCallId: planRevisionId,
          planId,
          planRevisionId,
          originToolCallId: planRevisionId,
        })
      );
      store.set(sessionRuntimeStatusAtom, "idle");
      await eventStoreProxy.set(events, input.sessionId);
      store.set(loadSessionAtom, { sessionId: input.sessionId, events });
      const snapshot = await eventStoreProxy.getSnapshot(input.sessionId);
      store.set(derivedSnapshotAtom, snapshot);
      return { ok: true, planRevisionId };
    } catch (err) {
      return asError(err);
    }
  };

  const seedShellProcess = async (input: {
    sessionId: string;
    pid: number;
    callId?: string;
    command: string;
    status?: "running" | "background";
  }): Promise<Result<{ sessionId: string; pid: number }>> => {
    try {
      if (!input.sessionId) {
        return {
          ok: false,
          error: "seedShellProcess: `sessionId` is required",
        };
      }
      if (!Number.isFinite(input.pid) || input.pid <= 0) {
        return {
          ok: false,
          error: "seedShellProcess: positive `pid` is required",
        };
      }
      store.set(updateShellProcessAtom, {
        type: "start",
        sessionId: input.sessionId,
        pid: input.pid,
        callId: input.callId ?? `e2e-shell-${input.pid}`,
        command: input.command,
      });
      if (input.status === "background") {
        store.set(updateShellProcessAtom, {
          type: "background",
          sessionId: input.sessionId,
          pid: input.pid,
          callId: input.callId ?? `e2e-shell-${input.pid}`,
        });
      }
      return { ok: true, sessionId: input.sessionId, pid: input.pid };
    } catch (err) {
      return asError(err);
    }
  };

  const seedSubagentJob = async (input: {
    sessionId: string;
    handle: string;
    agentName: string;
    subagentType?: string;
    status?: "running" | "completed" | "failed" | "killed";
  }): Promise<Result<{ sessionId: string; handle: string }>> => {
    try {
      if (!input.sessionId) {
        return {
          ok: false,
          error: "seedSubagentJob: `sessionId` is required",
        };
      }
      if (!input.handle) {
        return {
          ok: false,
          error: "seedSubagentJob: `handle` is required",
        };
      }
      store.set(updateSubagentJobAtom, {
        sessionId: input.sessionId,
        handle: input.handle,
        agentName: input.agentName || input.handle,
        subagentType: input.subagentType ?? "delegate",
        status: input.status ?? "running",
      });
      return { ok: true, sessionId: input.sessionId, handle: input.handle };
    } catch (err) {
      return asError(err);
    }
  };

  /**
   * Wire-path variant of `seedSubagentJob`: drives the debug-only Tauri
   * command `debug_seed_subagent_job`, which calls the PRODUCTION
   * `registry::register_subagent` in Rust. The resulting
   * `agent:subagent_job_changed` broadcast travels the real bus → IPC
   * channel → `handleSubagentJobChanged` → atom chain. No store writes
   * happen here — if the row appears in the pin bar, the whole wire
   * worked.
   */
  const debugSeedSubagentJobWire = async (input: {
    sessionId: string;
    handle: string;
    agentName: string;
    subagentType?: string;
  }): Promise<Result<{ sessionId: string; handle: string }>> => {
    try {
      if (!input.sessionId || !input.handle) {
        return {
          ok: false,
          error: "debugSeedSubagentJobWire: `sessionId` and `handle` required",
        };
      }
      await invoke("debug_seed_subagent_job", {
        sessionId: input.sessionId,
        handle: input.handle,
        agentName: input.agentName,
        subagentType: input.subagentType ?? "delegate",
      });
      return { ok: true, sessionId: input.sessionId, handle: input.handle };
    } catch (err) {
      return asError(err);
    }
  };

  /**
   * Wire-path seed for the Diff app's Submissions tab. Calls the debug-only
   * Tauri command `debug_seed_commit_link`, which writes a real orgtrack
   * `CommitLinkRecord` (the same shape a live provider run derives from a
   * `git push` shell event). `orgtrack_get_session_commit_links` then returns
   * it and `SessionReplay` renders the commit in the Submissions tab exactly
   * like a live push. No store writes happen here.
   */
  const debugSeedCommitLinkWire = async (input: {
    sessionId: string;
    commitSha: string;
  }): Promise<Result<{ sessionId: string; commitSha: string }>> => {
    try {
      if (!input.sessionId || !input.commitSha) {
        return {
          ok: false,
          error:
            "debugSeedCommitLinkWire: `sessionId` and `commitSha` required",
        };
      }
      await invoke("debug_seed_commit_link", {
        sessionId: input.sessionId,
        commitSha: input.commitSha,
      });
      return {
        ok: true,
        sessionId: input.sessionId,
        commitSha: input.commitSha,
      };
    } catch (err) {
      return asError(err);
    }
  };
  /** Wire-path kill: same Tauri command the pin bar's Stop button calls. */
  const killSubagentJobWire = async (
    handle: string
  ): Promise<{ ok: true } | Result<never>> => {
    try {
      await invoke("agent_kill_subagent_job", { handle });
      return { ok: true };
    } catch (err) {
      return asError(err);
    }
  };

  /**
   * Wire-path seed for the Diff app's Diff tab content. Calls the debug-only
   * Tauri command `debug_seed_final_diff`, which writes an orgtrack
   * `SessionFinalDiffRecord` with only the `diff` field set (no old_content /
   * new_content). `orgtrack_get_session_final_diffs` then returns it and the
   * `finalDiffToSection` fallback parses the unified diff to render content
   * instead of a blank/empty panel.
   */
  const debugSeedFinalDiffWire = async (input: {
    sessionId: string;
    source: string;
    filePath: string;
    diff: string;
  }): Promise<Result<{ sessionId: string; filePath: string }>> => {
    try {
      if (!input.sessionId || !input.source || !input.filePath || !input.diff) {
        return {
          ok: false,
          error:
            "debugSeedFinalDiffWire: `sessionId`, `source`, `filePath`, and `diff` required",
        };
      }
      await invoke("debug_seed_final_diff", {
        sessionId: input.sessionId,
        source: input.source,
        filePath: input.filePath,
        diff: input.diff,
      });
      return {
        ok: true,
        sessionId: input.sessionId,
        filePath: input.filePath,
      };
    } catch (err) {
      return asError(err);
    }
  };

  /**
   * Read-path counterpart to `debugSeedFinalDiffWire`. Calls the production
   * `getOrgtrackSessionFinalDiffs` lineage RPC and returns the row count for a
   * session, so a spec can assert the orgtrack final-diffs ledger reconciles
   * (e.g. after restore-to-checkpoint truncates the events cache and triggers a
   * `rebuild` reanalysis, the stale residue rows must drop).
   */
  const debugReadFinalDiffCountWire = async (input: {
    sessionId: string;
    source?: string;
  }): Promise<Result<{ sessionId: string; count: number }>> => {
    try {
      if (!input.sessionId) {
        return {
          ok: false,
          error: "debugReadFinalDiffCountWire: `sessionId` required",
        };
      }
      const diffs = await getOrgtrackSessionFinalDiffs({
        sessionId: input.sessionId,
        source: input.source,
      });
      return { ok: true, sessionId: input.sessionId, count: diffs.length };
    } catch (err) {
      return asError(err);
    }
  };

  const listRunningSubagentJobsWire = async (): Promise<
    Result<{ jobs: Json[] }>
  > => {
    try {
      const jobs = await invoke<Json[]>("agent_list_running_subagent_jobs");
      return { ok: true, jobs };
    } catch (err) {
      return asError(err);
    }
  };

  /**
   * Wire-path variant for the subagent MONITOR (clip model): seeds a child
   * `agent_sessions` row via the debug-only Tauri command
   * `debug_seed_child_session`, which calls the PRODUCTION `upsert_session`.
   * `useSubagentSessions` then discovers the row through the real
   * `es_get_child_sessions` query — including the backend-authoritative
   * `isTerminal` / `endedAt` clip fields. No store writes happen here.
   */
  const debugSeedChildSessionWire = async (input: {
    parentSessionId: string;
    sessionId: string;
    name: string;
    status: string;
    createdAt: string;
    updatedAt: string;
  }): Promise<Result<{ sessionId: string }>> => {
    try {
      if (!input.parentSessionId || !input.sessionId) {
        return {
          ok: false,
          error:
            "debugSeedChildSessionWire: `parentSessionId` and `sessionId` required",
        };
      }
      await invoke("debug_seed_child_session", {
        parentSessionId: input.parentSessionId,
        sessionId: input.sessionId,
        name: input.name,
        status: input.status,
        createdAt: input.createdAt,
        updatedAt: input.updatedAt,
      });
      return { ok: true, sessionId: input.sessionId };
    } catch (err) {
      return asError(err);
    }
  };

  /** Remove a seeded child session row (fixture cleanup). */
  const deleteSessionWire = async (
    sessionId: string
  ): Promise<{ ok: true } | Result<never>> => {
    try {
      await invoke("agent_delete_session", { sessionId });
      return { ok: true };
    } catch (err) {
      return asError(err);
    }
  };

  /**
   * Wire-path pending-plan seeder for the plan-lifecycle specs: drives the
   * debug-only Tauri command `debug_seed_pending_plan`, which calls the
   * PRODUCTION `PlanApprovalManager::mark_ready` — DB row, transcript event
   * and `agent:plan_ready_for_approval` broadcast are all live-shaped.
   */
  const debugSeedPendingPlanWire = async (input: {
    sessionId: string;
    planPath: string;
    planTitle: string;
    planContent: string;
  }): Promise<Result<{ sessionId: string }>> => {
    try {
      if (!input.sessionId || !input.planPath) {
        return {
          ok: false,
          error:
            "debugSeedPendingPlanWire: `sessionId` and `planPath` required",
        };
      }
      await invoke("debug_seed_pending_plan", {
        sessionId: input.sessionId,
        planPath: input.planPath,
        planTitle: input.planTitle,
        planContent: input.planContent,
      });
      return { ok: true, sessionId: input.sessionId };
    } catch (err) {
      return asError(err);
    }
  };

  return {
    seedChatEvents,
    seedSidebarSession,
    openWorkManagementTab,
    seedModeSwitchSession,
    seedPlanCard,
    seedShellProcess,
    seedSubagentJob,
    debugSeedSubagentJobWire,
    debugSeedCommitLinkWire,
    killSubagentJobWire,
    listRunningSubagentJobsWire,
    debugSeedChildSessionWire,
    debugSeedPendingPlanWire,
    debugSeedFinalDiffWire,
    debugReadFinalDiffCountWire,
    deleteSessionWire,
  };
}
