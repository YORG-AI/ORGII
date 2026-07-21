import { invoke } from "@tauri-apps/api/core";

import { getPendingPlanApproval } from "@src/api/tauri/agent";
import { promptDump } from "@src/api/tauri/agent/promptDump";
import { respondPlanApproval } from "@src/api/tauri/agent/session";
import { getOrgtrackFileSessionHistory } from "@src/api/tauri/lineage";
import { rpc } from "@src/api/tauri/rpc";
import { normalizeAgentExecMode } from "@src/config/sessionCreatorConfig";
import {
  clearSessionAtom,
  loadSessionAtom,
  sessionIdAtom,
} from "@src/engines/SessionCore";
import { resetTurnLifecycleForTests } from "@src/engines/SessionCore/control/turnLifecycle";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { isVisibleInChat } from "@src/engines/SessionCore/ingestion/visibilityFilters";
import {
  loadEvents,
  loadInitialTurnWindow,
  saveEvents,
} from "@src/engines/SessionCore/storage/cacheAdapter";
import { cliAdapter } from "@src/engines/SessionCore/sync/adapters";
import { getAdapterForSession } from "@src/engines/SessionCore/sync/types";
import {
  chatPanelTabsAtom,
  openOrFocusChatPanelStartPageTabAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import { reposAtom, selectedRepoIdAtom } from "@src/store/repo/atoms";
import {
  type ContextUsageSnapshot,
  isPendingCancelAtom,
  lastUserMessageAtom,
  restoreToInputAtom,
  sessionContextTokensAtom,
  sessionContextUsageAtom,
  sessionRolledBackAtom,
  sessionRuntimeStatusAtom,
  streamRetryStatusAtom,
  userInitiatedCancelAtom,
} from "@src/store/session/cliSessionStatusAtom";
import {
  pendingPlanApprovalsAtom,
  upsertPendingPlanApproval,
} from "@src/store/session/planApprovalAtom";
import { sessionsAtom } from "@src/store/session/sessionAtom/atoms";
import { loadSessions } from "@src/store/session/sessionAtom/loaders";
import { upsertSession } from "@src/store/session/sessionAtom/mutations";
import type { Session } from "@src/store/session/sessionAtom/types";
import {
  activeSessionIdAtom,
  jumpToSessionAtom,
  openSessionAtom,
  workstationActiveSessionIdAtom,
} from "@src/store/session/viewAtom";
import { chatImageAttachmentsAtom } from "@src/store/ui/chatImageAtom";
import {
  CHAT_PANEL_CONTENT_MODE,
  DEFAULT_CHAT_PANEL_CREATE_TARGET,
  chatPanelContentModeAtom,
  chatPanelCreateTargetAtom,
  chatPanelMaximizedAtom,
  chatPanelSelectedWorkItemAtom,
  chatWidthAtom,
} from "@src/store/ui/chatPanelAtom";
import {
  messageQueueAtom,
  queueEditTargetAtom,
  queueFlushRequestAtom,
} from "@src/store/ui/messageQueueAtom";
import { stationModeAtom } from "@src/store/ui/simulatorAtom";
import {
  workStationPrimarySidebarCollapsedAtom,
  workStationPrimarySidebarTabAtom,
} from "@src/store/ui/workStationAtom";
import { workspaceFoldersAtom } from "@src/store/ui/workspaceFoldersAtom";
import {
  type WorkStationLayoutState,
  createFileTab,
  openTab as openWorkstationTab,
  workstationLayoutAtom,
} from "@src/store/workstation/tabs";
import { LAYOUT_STORAGE_KEY } from "@src/store/workstation/tabs/storage";
import { isCliSession } from "@src/util/session/sessionDispatch";

import { asError } from "../result";
import type { E2EStore, Json, Result } from "../types";
import { createInspectChatStateHelper } from "./sessionHelpers/inspectChatState";
import { createSessionSeederHelpers } from "./sessionHelpers/seeders";
import { waitForSessionSurface } from "./sessionHelpers/waitForSessionSurface";

function toStoreSession(record: {
  sessionId: string;
  status?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  userInput?: string | null;
  name?: string | null;
  category?: string | null;
  model?: string | null;
  keySource?: string | null;
  accountId?: string | null;
  workspacePath?: string | null;
  worktreePath?: string | null;
  worktreeBranch?: string | null;
  baseBranch?: string | null;
  mergeStatus?: string | null;
  workItemId?: string | null;
  projectSlug?: string | null;
  agentRole?: string | null;
  parentSessionId?: string | null;
  orgMemberId?: string | null;
  agentDefinitionId?: string | null;
  agentDisplayName?: string | null;
  agentExecMode?: string | null;
}): Session {
  return {
    session_id: record.sessionId,
    status: record.status ?? "idle",
    created_at: record.createdAt ?? "",
    updated_at: record.updatedAt ?? "",
    user_input: record.userInput ?? undefined,
    name: record.name ?? undefined,
    category: record.category === "cli_agent" ? "cli_agent" : "rust_agent",
    model: record.model ?? undefined,
    keySource: record.keySource === "hosted_key" ? "hosted_key" : "own_key",
    accountId: record.accountId ?? undefined,
    repoPath: record.workspacePath ?? undefined,
    worktreePath: record.worktreePath ?? undefined,
    worktreeBranch: record.worktreeBranch ?? undefined,
    baseBranch: record.baseBranch ?? undefined,
    mergeStatus:
      record.mergeStatus === "pending" ||
      record.mergeStatus === "merged" ||
      record.mergeStatus === "conflict" ||
      record.mergeStatus === "skipped" ||
      record.mergeStatus === "failed"
        ? record.mergeStatus
        : undefined,
    workItemId: record.workItemId ?? undefined,
    agentRole:
      record.agentRole === "coding" ||
      record.agentRole === "sde" ||
      record.agentRole === "review" ||
      record.agentRole === "orchestrator" ||
      record.agentRole === "custom" ||
      record.agentRole === "sub_agent"
        ? record.agentRole
        : undefined,
    parentSessionId: record.parentSessionId ?? undefined,
    orgMemberId: record.orgMemberId ?? undefined,
    agentDefinitionId: record.agentDefinitionId ?? undefined,
    agentDisplayName: record.agentDisplayName ?? undefined,
    agentExecMode: normalizeAgentExecMode(record.agentExecMode) ?? undefined,
    is_active: true,
  };
}

export function createSessionHelpers(store: E2EStore) {
  const promptDumpHelper = async (sessionId: string) => {
    try {
      if (!sessionId) {
        return {
          ok: false as const,
          error: "promptDump: `sessionId` is required",
        };
      }
      const dump = await promptDump(sessionId);
      return { ok: true as const, dump };
    } catch (err) {
      return asError(err);
    }
  };

  const getActiveSessionId = async (): Promise<
    Result<{ sessionId: string | null }>
  > => {
    try {
      const sessionId = store.get(activeSessionIdAtom);
      return { ok: true, sessionId };
    } catch (err) {
      return asError(err);
    }
  };

  const openWorkstationFile = async (
    filePath: string
  ): Promise<Result<{ filePath: string }>> => {
    try {
      if (!filePath) {
        return {
          ok: false,
          error: "openWorkstationFile: `filePath` is required",
        };
      }
      const tab = createFileTab(filePath);
      // A prior chat/session scenario may leave the panel maximized, which
      // suppresses the workstation content host. Opening a file must make its
      // editor visible before the tab can be exercised through WebDriver.
      store.set(chatPanelMaximizedAtom, false);
      store.set(workStationPrimarySidebarTabAtom, "files");
      store.set(workStationPrimarySidebarCollapsedAtom, false);
      const layout = store.get(workstationLayoutAtom);
      const nextLayout: WorkStationLayoutState = {
        ...layout,
        mainPane: openWorkstationTab(
          layout?.mainPane ?? { tabs: [], activeTabId: null },
          tab
        ),
      };
      // Keep the persistence source in sync so an in-flight layout hydration
      // cannot overwrite the file tab immediately after this helper returns.
      localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(nextLayout));
      store.set(workstationLayoutAtom, nextLayout);
      return { ok: true, filePath };
    } catch (err) {
      return asError(err);
    }
  };

  const inspectOrgtrackFileSessionHistory = async (input: {
    repoPath: string;
    filePath: string;
    limit?: number;
    offset?: number;
  }): Promise<Result<{ history: Json }>> => {
    try {
      const history = await getOrgtrackFileSessionHistory(input);
      return { ok: true, history: history as unknown as Json };
    } catch (err) {
      return asError(err);
    }
  };

  const inspectCliSessionStatus = async (
    sessionId: string
  ): Promise<Result<{ session: Json | null }>> => {
    try {
      if (!sessionId) {
        return {
          ok: false,
          error: "inspectCliSessionStatus: `sessionId` is required",
        };
      }
      const session = (await invoke("cli_agent_status", {
        sessionId,
      })) as Json | null;
      return { ok: true, session };
    } catch (err) {
      return asError(err);
    }
  };

  const inspectCliHistoryMutation = async (
    sessionId: string
  ): Promise<Result<{ mutation: Json | null }>> => {
    try {
      if (!sessionId) {
        return {
          ok: false,
          error: "inspectCliHistoryMutation: `sessionId` is required",
        };
      }
      const mutation = (await invoke("cli_agent_history_mutation", {
        sessionId,
      })) as Json | null;
      return { ok: true, mutation };
    } catch (err) {
      return asError(err);
    }
  };

  const resetToNewSession = async (): Promise<{ ok: true } | Result<never>> => {
    try {
      store.set(clearSessionAtom);
      store.set(activeSessionIdAtom, null);
      store.set(workstationActiveSessionIdAtom, null);
      // A new session is composed on Agent Station. My Station can now show
      // the empty WorkStation tab-pool start page, so resetting there no
      // longer mounts SessionCreator even after all session atoms are clear.
      store.set(stationModeAtom, "agent-station");
      store.set(chatPanelContentModeAtom, CHAT_PANEL_CONTENT_MODE.SESSION);
      // New-session creation now lives inside the singleton Launchpad's Work
      // tab. Focus that canonical tab instead of forcing the legacy bare
      // session surface, which no longer mounts SessionCreator by itself.
      store.set(openOrFocusChatPanelStartPageTabAtom, {});
      store.set(chatPanelCreateTargetAtom, DEFAULT_CHAT_PANEL_CREATE_TARGET);
      store.set(chatPanelSelectedWorkItemAtom, null);
      store.set(chatPanelMaximizedAtom, true);
      store.set(chatWidthAtom, 560);
      store.set(sessionIdAtom, null);
      store.set(messageQueueAtom, []);
      store.set(queueEditTargetAtom, null);
      store.set(queueFlushRequestAtom, 0);
      resetTurnLifecycleForTests();
      store.set(chatImageAttachmentsAtom, []);
      store.set(isPendingCancelAtom, false);
      store.set(userInitiatedCancelAtom, false);
      store.set(sessionRuntimeStatusAtom, "idle");
      store.set(sessionContextTokensAtom, 0);
      store.set(sessionContextUsageAtom, null);
      store.set(streamRetryStatusAtom, null);
      store.set(restoreToInputAtom, null);
      store.set(lastUserMessageAtom, null);
      store.set(sessionRolledBackAtom, false);
      const timeoutAt = Date.now() + 20_000;
      while (Date.now() < timeoutAt) {
        const creatorShell = document.querySelector(
          '[data-testid="session-creator-chat-panel"]'
        );
        const chatInput = document.querySelector('[data-testid="chat-input"]');
        const composerEditor = document.querySelector(
          '[contenteditable="true"]'
        );
        if (creatorShell && chatInput && composerEditor) {
          return { ok: true };
        }
        store.set(activeSessionIdAtom, null);
        store.set(workstationActiveSessionIdAtom, null);
        store.set(sessionIdAtom, null);
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      }
      const bodyText = document.body?.textContent?.slice(0, 500) ?? "";
      const tabState = store.get(chatPanelTabsAtom);
      return {
        ok: false,
        error: `resetToNewSession: SessionCreator did not render after clearing session state; state=${JSON.stringify(
          {
            tabState,
            contentMode: store.get(chatPanelContentModeAtom),
            selectedWorkItem: store.get(chatPanelSelectedWorkItemAtom)?.shortId,
            activeSessionId: store.get(activeSessionIdAtom),
            workstationActiveSessionId: store.get(
              workstationActiveSessionIdAtom
            ),
            sessionId: store.get(sessionIdAtom),
          }
        )}; body=${JSON.stringify(bodyText)}`,
      };
    } catch (err) {
      return asError(err);
    }
  };

  const launchSession = async (
    params: Json
  ): Promise<Result<{ result: Json }>> => {
    try {
      const launchParams: Json = {
        category: "rust_agent",
        content: params.prompt ?? params.content ?? "",
        ...params,
      };
      if (typeof launchParams.workspacePath !== "string") {
        const repos = store.get(reposAtom);
        const selectedRepoId = store.get(selectedRepoIdAtom);
        const selectedRepo =
          repos.find((repo) => repo.id === selectedRepoId) ?? repos[0];
        if (selectedRepo?.path) {
          launchParams.workspacePath = selectedRepo.path;
        }
      }
      const workspacePath =
        launchParams.workspacePath ?? launchParams.workspace_path;
      const additionalDirectories =
        launchParams.additionalDirectories ??
        launchParams.additional_directories ??
        (() => {
          if (typeof workspacePath !== "string" || workspacePath.length === 0) {
            return undefined;
          }
          const normalize = (path: string) => path.replace(/\/+$/, "");
          const normalizedProject = normalize(workspacePath);
          const folders = store.get(workspaceFoldersAtom);
          const workspaceIncludesProject = folders.some(
            (folder) => normalize(folder.path) === normalizedProject
          );
          if (!workspaceIncludesProject) return undefined;
          const extras = folders
            .map((folder) => normalize(folder.path))
            .filter((path) => path && path !== normalizedProject);
          return extras.length > 0 ? extras : undefined;
        })();
      const rustParams = {
        ...launchParams,
        workspace_path: workspacePath,
        key_source: launchParams.keySource ?? launchParams.key_source,
        account_id: launchParams.accountId ?? launchParams.account_id,
        native_harness_type:
          launchParams.nativeHarnessType ?? launchParams.native_harness_type,
        hosted_token: launchParams.hostedToken ?? launchParams.hosted_token,
        agent_definition_id:
          launchParams.agentDefinitionId ?? launchParams.agent_definition_id,
        agent_org_id: launchParams.agentOrgId ?? launchParams.agent_org_id,
        work_item_id: launchParams.workItemId ?? launchParams.work_item_id,
        agent_role: launchParams.agentRole ?? launchParams.agent_role,
        worktree_path: launchParams.worktreePath ?? launchParams.worktree_path,
        project_slug: launchParams.projectSlug ?? launchParams.project_slug,
        additionalDirectories,
      };
      const result = (await invoke("session_launch", {
        params: rustParams,
      })) as Json;
      if (result && typeof result === "object") {
        (result as Json).__e2eLaunchParams = {
          workspace_path: rustParams.workspace_path,
          additionalDirectories: rustParams.additionalDirectories,
          workspaceFolders: store.get(workspaceFoldersAtom),
          selectedRepoId: store.get(selectedRepoIdAtom),
        };
      }
      const sessionId =
        typeof result.sessionId === "string"
          ? result.sessionId
          : typeof result.session_id === "string"
            ? result.session_id
            : null;
      if (sessionId) {
        store.set(activeSessionIdAtom, sessionId);
        store.set(workstationActiveSessionIdAtom, sessionId);
        await waitForSessionSurface(sessionId);
      }
      return { ok: true, result };
    } catch (err) {
      return asError(err);
    }
  };

  const openSession = async (
    sessionId: string
  ): Promise<Result<{ sessionId: string }>> => {
    try {
      if (!sessionId) {
        return { ok: false, error: "openSession: `sessionId` is required" };
      }
      const directSession = await rpc.agentSession.getSession({ sessionId });
      if (directSession) {
        upsertSession(toStoreSession(directSession));
      }
      const sessionName =
        typeof directSession?.name === "string"
          ? directSession.name
          : undefined;
      const repoPath =
        typeof directSession?.workspacePath === "string"
          ? directSession.workspacePath
          : undefined;

      store.set(stationModeAtom, "my-station");
      store.set(chatPanelContentModeAtom, CHAT_PANEL_CONTENT_MODE.SESSION);
      store.set(chatPanelCreateTargetAtom, DEFAULT_CHAT_PANEL_CREATE_TARGET);
      store.set(chatPanelSelectedWorkItemAtom, null);
      store.set(chatPanelMaximizedAtom, true);
      store.set(chatWidthAtom, 560);
      store.set(openSessionAtom, { sessionId, sessionName, repoPath });
      store.set(sessionIdAtom, sessionId);
      store.set(sessionRuntimeStatusAtom, "idle");
      await eventStoreProxy.switchSession(sessionId);

      // CLI sessions: the authoritative post-restore history lives in
      // `code_session_chunks`, read via the adapter. The session-persistence
      // turn-index / events cache can survive a restore-to-checkpoint in an
      // inconsistent state (a turn_count that no longer matches the truncated
      // chunks, e.g. cursor-cli's double session_end inflating the count), so
      // `loadInitialTurnWindow` may return a window that renders nothing even
      // though stale rows are present. Always reload CLI history straight from
      // the adapter (the chunk read can briefly lag the post-restore DB commit
      // on a fresh page load, so retry a few times) rather than trusting the
      // cached turn window.
      let events: SessionEvent[] = [];
      if (isCliSession(sessionId)) {
        const ADAPTER_LOAD_ATTEMPTS = 5;
        for (let attempt = 1; attempt <= ADAPTER_LOAD_ATTEMPTS; attempt++) {
          const controller = new AbortController();
          const loaded = await cliAdapter.loadHistory(
            sessionId,
            controller.signal
          );
          if (loaded.length > 0) {
            events = loaded;
            break;
          }
          if (attempt < ADAPTER_LOAD_ATTEMPTS) {
            await new Promise((resolve) => window.setTimeout(resolve, 400));
          }
        }
      } else {
        const initialWindow = await loadInitialTurnWindow(sessionId);
        events =
          initialWindow.turns.length > 0
            ? initialWindow.events
            : await loadEvents(sessionId);
        // Mirror the production reload guard (`handleCacheHit` in
        // sessionSwitchOrchestrator): fall back to a fresh adapter load
        // whenever the cached events are empty OR contain nothing renderable
        // in chat, instead of only when the array is strictly length 0.
        const cachedEventsRenderable =
          events.length > 0 && events.some(isVisibleInChat);
        if (!cachedEventsRenderable) {
          const adapter = getAdapterForSession(sessionId);
          if (adapter) {
            const ADAPTER_LOAD_ATTEMPTS = 5;
            for (let attempt = 1; attempt <= ADAPTER_LOAD_ATTEMPTS; attempt++) {
              const controller = new AbortController();
              const loaded = await adapter.loadHistory(
                sessionId,
                controller.signal
              );
              if (loaded.length > 0) {
                events = loaded;
                break;
              }
              if (attempt < ADAPTER_LOAD_ATTEMPTS) {
                await new Promise((resolve) => window.setTimeout(resolve, 400));
              }
            }
          }
        }
      }
      if (events.length > 0) {
        await eventStoreProxy.set(events, sessionId);
      }
      store.set(loadSessionAtom, { sessionId, events, isFromCache: true });
      const pendingPlan = await getPendingPlanApproval(sessionId);
      if (pendingPlan) {
        store.set(pendingPlanApprovalsAtom, (prev) =>
          upsertPendingPlanApproval(prev, pendingPlan)
        );
      }
      store.set(jumpToSessionAtom, sessionId);
      store.set(activeSessionIdAtom, sessionId);
      store.set(workstationActiveSessionIdAtom, sessionId);
      await waitForSessionSurface(sessionId);
      await new Promise((resolve) => window.setTimeout(resolve, 150));
      store.set(activeSessionIdAtom, sessionId);
      store.set(workstationActiveSessionIdAtom, sessionId);
      return { ok: true, sessionId };
    } catch (err) {
      return asError(err);
    }
  };

  const getSessionAggregateRowFromList = async (
    sessionId: string
  ): Promise<Result<{ session: Json | null; diagnostics?: Json }>> => {
    try {
      if (!sessionId) {
        return {
          ok: false,
          error: "getSessionAggregateRowFromList: `sessionId` is required",
        };
      }
      const listed = await rpc.sessionAggregate.list({
        filter: {
          category: "agent",
          limit: 200,
          sortBy: "updated_at",
          sortOrder: "desc",
        },
      });
      const aggregateSession =
        listed.sessions.find((row) => row.sessionId === sessionId) ?? null;
      return {
        ok: true,
        session: aggregateSession as unknown as Json | null,
        diagnostics: {
          source: aggregateSession ? "aggregate" : "missing",
          aggregateCount: listed.sessions.length,
          aggregateSampleIds: listed.sessions
            .slice(0, 10)
            .map((row) => row.sessionId),
        } as unknown as Json,
      };
    } catch (err) {
      return asError(err);
    }
  };

  const getSessionAggregateRow = async (
    sessionId: string
  ): Promise<Result<{ session: Json | null; diagnostics?: Json }>> => {
    try {
      if (!sessionId) {
        return {
          ok: false,
          error: "getSessionAggregateRow: `sessionId` is required",
        };
      }
      const directSession = await rpc.agentSession.getSession({ sessionId });
      if (directSession) {
        return {
          ok: true,
          session: {
            ...directSession,
            category: "rust_agent",
          } as unknown as Json,
          diagnostics: { source: "direct" } as unknown as Json,
        };
      }

      return getSessionAggregateRowFromList(sessionId);
    } catch (err) {
      return asError(err);
    }
  };

  const findSessionAggregateByWorkItem = async (
    workItemId: string
  ): Promise<Result<{ session: Json | null }>> => {
    try {
      if (!workItemId) {
        return {
          ok: false,
          error: "findSessionAggregateByWorkItem: `workItemId` is required",
        };
      }
      const listed = await rpc.sessionAggregate.list({
        filter: {
          category: "agent",
          limit: 200,
          sortBy: "updated_at",
          sortOrder: "desc",
        },
      });
      const session =
        listed.sessions.find((row) => row.workItemId === workItemId) ?? null;
      return { ok: true, session: session as unknown as Json | null };
    } catch (err) {
      return asError(err);
    }
  };

  const seedSessionContextUsage = async (
    usage: Json
  ): Promise<Result<{ usedTokens: number }>> => {
    try {
      const usedTokens =
        usage &&
        typeof usage === "object" &&
        typeof usage.usedTokens === "number"
          ? usage.usedTokens
          : null;
      if (usedTokens === null) {
        return {
          ok: false,
          error: "seedSessionContextUsage: `usedTokens` is required",
        };
      }
      store.set(sessionContextTokensAtom, usedTokens);
      store.set(
        sessionContextUsageAtom,
        usage as unknown as ContextUsageSnapshot
      );
      return { ok: true, usedTokens };
    } catch (err) {
      return asError(err);
    }
  };

  const seeders = createSessionSeederHelpers(store);

  /**
   * Wire-path exec-mode switch for the plan-lifecycle specs: the same
   * `session_patch` RPC the ModePill drives. Pre-fix this was Chokepoint B
   * (auto-Abandon of the pending plan); the decoupled lifecycle must leave
   * the pending row untouched.
   */
  const patchSessionExecModeWire = async (
    sessionId: string,
    agentExecMode: string
  ): Promise<{ ok: true } | Result<never>> => {
    try {
      await rpc.sessionAggregate.patch({
        sessionId,
        patch: { agentExecMode },
      });
      return { ok: true };
    } catch (err) {
      return asError(err);
    }
  };

  /**
   * Backend-truth pending-plan query (`agent_get_pending_plan_approval`) —
   * bypasses the FE atom so specs assert the DB row, not the mirror.
   */
  const getPendingPlanApprovalWire = async (
    sessionId: string
  ): Promise<Result<{ snapshot: Json | null }>> => {
    try {
      const snapshot = await getPendingPlanApproval(sessionId);
      return { ok: true, snapshot: (snapshot as unknown as Json) ?? null };
    } catch (err) {
      return asError(err);
    }
  };

  /**
   * Production plan-approval response (`agent_plan_approval_response`) —
   * the exact RPC behind the Build/Skip buttons, callable cross-mode.
   */
  const respondPlanApprovalWire = async (
    sessionId: string,
    choice: "approve" | "approve_with_edits" | "reject"
  ): Promise<{ ok: true } | Result<never>> => {
    try {
      await respondPlanApproval(sessionId, choice, undefined, {});
      return { ok: true };
    } catch (err) {
      return asError(err);
    }
  };

  const seedPersistedCachedSession = async (input: {
    sessionId: string;
    events: Json[];
    name?: string;
    userInput?: string;
    category?: "cli_agent" | "rust_agent";
    status?: string;
  }): Promise<Result<{ sessionId: string; eventCount: number }>> => {
    try {
      if (!input.sessionId) {
        return {
          ok: false,
          error: "seedPersistedCachedSession: `sessionId` is required",
        };
      }
      const now = new Date().toISOString();
      const session = toStoreSession({
        sessionId: input.sessionId,
        status: input.status ?? "completed",
        createdAt: now,
        updatedAt: now,
        userInput: input.userInput ?? input.name ?? input.sessionId,
        name: input.name ?? input.userInput ?? input.sessionId,
        category: input.category ?? "cli_agent",
      });
      upsertSession(session);
      await saveEvents(
        input.sessionId,
        input.events as unknown as SessionEvent[]
      );
      return {
        ok: true,
        sessionId: input.sessionId,
        eventCount: input.events.length,
      };
    } catch (err) {
      return asError(err);
    }
  };

  const reloadSessionList = async (): Promise<
    Result<{ count: number; sessionIds: string[] }>
  > => {
    try {
      await loadSessions({ forceRefresh: true });
      const sessions = store.get(sessionsAtom) as Session[];
      return {
        ok: true,
        count: sessions.length,
        sessionIds: sessions.map((session) => session.session_id),
      };
    } catch (err) {
      return asError(err);
    }
  };

  return {
    promptDump: promptDumpHelper,
    getActiveSessionId,
    openWorkstationFile,
    inspectOrgtrackFileSessionHistory,
    inspectCliSessionStatus,
    inspectCliHistoryMutation,
    resetToNewSession,
    openSession,
    reloadSessionList,
    launchSession,
    getSessionAggregateRow,
    getSessionAggregateRowFromList,
    findSessionAggregateByWorkItem,
    seedSessionContextUsage,
    seedPersistedCachedSession,
    seedChatEvents: seeders.seedChatEvents,
    seedSidebarSession: seeders.seedSidebarSession,
    openWorkManagementTab: seeders.openWorkManagementTab,
    seedModeSwitchSession: seeders.seedModeSwitchSession,
    seedPlanCard: seeders.seedPlanCard,
    seedShellProcess: seeders.seedShellProcess,
    seedSubagentJob: seeders.seedSubagentJob,
    debugSeedSubagentJobWire: seeders.debugSeedSubagentJobWire,
    debugSeedCommitLinkWire: seeders.debugSeedCommitLinkWire,
    debugSeedFinalDiffWire: seeders.debugSeedFinalDiffWire,
    debugReadFinalDiffCountWire: seeders.debugReadFinalDiffCountWire,
    killSubagentJobWire: seeders.killSubagentJobWire,
    listRunningSubagentJobsWire: seeders.listRunningSubagentJobsWire,
    debugSeedChildSessionWire: seeders.debugSeedChildSessionWire,
    debugSeedPendingPlanWire: seeders.debugSeedPendingPlanWire,
    deleteSessionWire: seeders.deleteSessionWire,
    patchSessionExecModeWire,
    getPendingPlanApprovalWire,
    respondPlanApprovalWire,
    inspectChatState: createInspectChatStateHelper(store),
  };
}
