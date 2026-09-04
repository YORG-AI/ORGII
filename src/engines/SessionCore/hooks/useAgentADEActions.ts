/**
 * useAgentADEActions Hook
 *
 * Bridges global agent ADE (Agentic Development Environment) action requests
 * to the frontend ActionSystem.
 *
 * Behaviour today:
 *   - category === "session" → dispatched normally (required for manage_session)
 *   - layer === "gui" → dispatched only while global Agent Control is on
 *   - layer === "action" → rejected when a native backend tool should be used
 *
 * Bridges the agent's `ade` tool to the frontend ActionSystem.
 * Listens for `agent-ade-action` CustomEvents (dispatched by the agent event handlers),
 * executes the requested action via zodActionRegistry, and reports the result
 * back to the Rust backend via the `agent_ade_action_result` Tauri command.
 *
 * Also ensures that ActionSystem actions are registered (via registerCoreActions)
 * so they're available even if the Workstation editor isn't mounted.
 */
import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";

import {
  ACTION_ID,
  initializeServices,
  registerCoreActions,
  zodActionRegistry,
} from "@src/ActionSystem";
import { sendAdeActionResult } from "@src/api/tauri/agent";
import { clearSessionAtom } from "@src/engines/SessionCore/core/atoms/actions";
import {
  GLOBAL_UI_CHANNEL_SESSION_ID,
  subscribeToSessionEvents,
} from "@src/engines/SessionCore/sync/useSessionChannel";
import { reposAtom } from "@src/store/repo/atoms";
import {
  SESSION_TARGET_KIND,
  sessionCreatorStateAtom,
} from "@src/store/session/creatorStateAtom";
import {
  activeSessionIdAtom,
  workstationActiveSessionIdAtom,
} from "@src/store/session/viewAtom";
import {
  CHAT_PANEL_SURFACE_KIND,
  chatPanelNavigateAtom,
  restoreChatWidthAtom,
} from "@src/store/ui/chatPanelAtom";
import { adeManagerEnabledAtom } from "@src/store/ui/uiAtom";
import { activeWorkspaceRootAtom } from "@src/store/workspace";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";
import { recordPushEvent } from "@src/util/monitoring/apiTracker";

import {
  type AdeActionDetail,
  dispatchAdeActionDetail,
  parseAdeActionEnvelope,
} from "./adeActionEnvelope";
import { resolveTrustedDispatchParams } from "./adeReplyBinding";

/**
 * Pending session proposal — set by `session.propose` handler,
 * consumed by `AdeAwareSessionCreatorSlot` in AppLayout when the
 * user launches a session from the creator.
 */
export interface PendingSessionProposal {
  correlationId: string;
  task: string;
  agentDefinitionId?: string;
  repoPath?: string;
  model?: string;
  expiresAt: number;
}

export const pendingSessionProposal: {
  current: PendingSessionProposal | null;
} = {
  current: null,
};

const ADE_MANAGER_REQUIRED_MESSAGE =
  "ADE Manager is off. Toggle ADE Manager on to allow GUI automation actions.";

function getStringParam(
  params: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = params?.[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function matchesGuiManifestQuery(
  action: ReturnType<
    typeof zodActionRegistry.getGUIControlManifest
  >["actions"][number],
  query: string
): boolean {
  const haystack = [
    action.id,
    action.category,
    action.description,
    action.longDescription,
    ...(action.tags ?? []),
    ...(action.examples ?? []),
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ")
    .toLowerCase();

  return haystack.includes(query.toLowerCase());
}

// ============================================
// Hook
// ============================================

/**
 * Listens for ADE action requests from the agent and dispatches them
 * through the ActionSystem. Reports results back via Tauri command.
 *
 * Must be mounted inside a component tree that has Jotai provider (for repo atom).
 */
export function useAgentADEActions(): void {
  const activeWorkspaceRoot = useAtomValue(activeWorkspaceRootAtom);
  const adeManagerEnabled = useAtomValue(adeManagerEnabledAtom);
  const cleanupRef = useRef<(() => void) | null>(null);
  const adeManagerEnabledRef = useRef(adeManagerEnabled);
  const handledCorrelationIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    adeManagerEnabledRef.current = adeManagerEnabled;
  }, [adeManagerEnabled]);

  useEffect(() => {
    return subscribeToSessionEvents(
      GLOBAL_UI_CHANNEL_SESSION_ID,
      (rawMessage) => {
        try {
          const detail = parseAdeActionEnvelope(rawMessage);
          if (!detail) return;
          recordPushEvent("channel", "ade-actions");
          dispatchAdeActionDetail(detail);
        } catch {
          return;
        }
      }
    );
  }, []);

  // Register actions and listen for ADE action events
  useEffect(() => {
    const repoPath = activeWorkspaceRoot?.path ?? "";
    const repoId = activeWorkspaceRoot?.repoId ?? activeWorkspaceRoot?.repo?.id;

    // Ensure ActionSystem actions are registered (ref counted — safe if
    // Workstation has already registered them). This means ADE actions are
    // available even when the user isn't looking at the Code Editor.
    if (repoPath) {
      initializeServices(repoPath, repoId).catch(() => {
        // Best effort — services may already be initialized
      });
      cleanupRef.current = registerCoreActions(repoPath);
    }

    async function handleADEAction(evt: Event) {
      const detail = (evt as CustomEvent<AdeActionDetail>).detail;
      if (!detail?.correlationId) return;

      if (handledCorrelationIdsRef.current.has(detail.correlationId)) return;
      handledCorrelationIdsRef.current.add(detail.correlationId);
      if (handledCorrelationIdsRef.current.size > 100) {
        const oldestCorrelationId = handledCorrelationIdsRef.current
          .values()
          .next().value;
        if (oldestCorrelationId)
          handledCorrelationIdsRef.current.delete(oldestCorrelationId);
      }

      const { correlationId, params } = detail;
      const operation = detail.operation ?? "dispatch";
      const action = detail.action ?? getStringParam(params, "action");

      try {
        // ── session.propose ──────────────────────────────────────────────
        // Pre-seed the session creator atoms and navigate the chat panel
        // to the creator view. The AdeAwareSessionCreatorSlot in AppLayout
        // intercepts onSessionStart and calls sendAdeActionResult with the
        // new session ID, resolving the Rust-side tool call.
        if (action === "session.propose") {
          const task = String(params.task ?? "");
          const agentDefinitionId = params.agentDefinitionId
            ? String(params.agentDefinitionId)
            : undefined;
          const repoPath = params.repoPath
            ? String(params.repoPath)
            : undefined;
          const model = params.model ? String(params.model) : undefined;

          const store = getInstrumentedStore();

          store.set(sessionCreatorStateAtom, (prev) => {
            const next = { ...prev };
            if (agentDefinitionId) {
              next.dispatchCategory = "rust_agent";
              next.targetKind = SESSION_TARGET_KIND.AGENT;
              next.selectedAgentDefinitionId = agentDefinitionId;
              next.selectedAgentOrgId = null;
              next.cliAgentType = null;
              next.agentName = null;
              next.agentIconId = null;
            }
            if (repoPath) {
              const normalized = repoPath.replace(/\/+$/, "");
              const repos = store.get(reposAtom);
              const matched = repos.find((repo) => {
                const rp = (repo.path ?? repo.fs_uri ?? "").replace(/\/+$/, "");
                return rp === normalized;
              });
              if (matched) {
                next.source = {
                  type: "local",
                  repoId: matched.id,
                  repoName: matched.name,
                  repoPath: normalized,
                };
              }
            }
            return next;
          });

          // Navigate chat panel to the session creator (same as "New session" button).
          store.set(chatPanelNavigateAtom, {
            kind: CHAT_PANEL_SURFACE_KIND.SESSION,
          });
          store.set(clearSessionAtom);
          store.set(workstationActiveSessionIdAtom, null);
          store.set(activeSessionIdAtom, null);
          store.set(restoreChatWidthAtom);

          // Store the pending proposal so AdeAwareSessionCreatorSlot can
          // resolve it when the user launches the session.
          pendingSessionProposal.current = {
            correlationId,
            task,
            agentDefinitionId,
            repoPath,
            model,
            expiresAt: Date.now() + 5 * 60 * 1000,
          };

          // Notify the ADE palette countdown card.
          window.dispatchEvent(
            new CustomEvent("ade-session-proposal", {
              detail: pendingSessionProposal.current,
            })
          );

          // Do NOT call sendAdeActionResult here — it will be called by
          // AdeAwareSessionCreatorSlot once the session is created.
          return;
        }

        if (operation === "list") {
          const query = getStringParam(params, "query");
          const inspectResult = await zodActionRegistry.execute(
            ACTION_ID.GUI_INSPECT,
            {
              ...(query ? { query } : {}),
            }
          );
          await sendAdeActionResult(correlationId, {
            success: inspectResult.success,
            message: inspectResult.message ?? "Collected GUI manifest",
            data: inspectResult.data,
          });
          return;
        }

        if (operation === "inspect") {
          const targetAction = action ?? getStringParam(params, "actionId");
          const manifest = zodActionRegistry.getGUIControlManifest();
          const query = getStringParam(params, "query");
          const actions = targetAction
            ? manifest.actions.filter(
                (manifestAction) => manifestAction.id === targetAction
              )
            : query
              ? manifest.actions.filter((manifestAction) =>
                  matchesGuiManifestQuery(manifestAction, query)
                )
              : manifest.actions;

          await sendAdeActionResult(correlationId, {
            success: targetAction ? actions.length === 1 : true,
            message:
              targetAction && actions.length === 0
                ? `Unknown GUI action: ${targetAction}`
                : `Inspected ${actions.length} GUI action${actions.length === 1 ? "" : "s"}`,
            data: { actions },
          });
          return;
        }

        if (!action) {
          await sendAdeActionResult(correlationId, {
            success: false,
            message: "Missing action for GUI dispatch",
          });
          return;
        }

        // Check if actions are registered (registry might be empty if no repo is selected)
        if (!zodActionRegistry.has(action)) {
          const adeActions = zodActionRegistry.getADEExposedActions();
          const availableIds = adeActions.map((act) => act.meta.id);
          const message =
            availableIds.length === 0
              ? `No ADE actions are registered. A repo must be selected in the ADE.`
              : `Unknown action: "${action}". Available ADE actions: ${availableIds.slice(0, 20).join(", ")}${availableIds.length > 20 ? ` (and ${availableIds.length - 20} more)` : ""}`;

          await sendAdeActionResult(correlationId, {
            success: false,
            message,
          });
          return;
        }

        // Check layer — reject "action" layer actions that have native
        // backend equivalents (the agent should call the native tool
        // directly instead). Exception: "session" category actions are
        // always allowed (designed for ActionBridge / manage_session).
        const actionLayer = zodActionRegistry.getActionLayer(action);
        const actionObj = zodActionRegistry.get(action);
        const category = actionObj?.meta.category ?? "";

        const isReadOnlyGuiInspect = action === ACTION_ID.GUI_INSPECT;

        // Session actions are backend session control; GUI-layer actions require the explicit global toggle.
        if (
          !isReadOnlyGuiInspect &&
          !adeManagerEnabledRef.current &&
          category !== "session"
        ) {
          await sendAdeActionResult(correlationId, {
            success: false,
            message: `${ADE_MANAGER_REQUIRED_MESSAGE} (action="${action}")`,
          });
          return;
        }

        if (actionLayer === "action" && category !== "session") {
          const nativeToolHints: Record<string, string> = {
            git: 'Use the native "git" tool instead',
            search: 'Use the native "code_search" tool instead',
            terminal: 'Use the native "run_shell" tool instead',
            file: 'Use the native "edit_file" or "run_shell" tool instead',
            test: 'Use the native "run_shell" tool to run test commands instead',
          };
          const hint =
            nativeToolHints[category] ?? "Use the corresponding native tool";

          await sendAdeActionResult(correlationId, {
            success: false,
            message: `Action "${action}" has a native backend equivalent and is not available via the ade tool. ${hint}.`,
          });
          return;
        }

        const dispatchParams = resolveTrustedDispatchParams(
          action,
          params,
          detail.invokingSessionId
        );
        const result = await zodActionRegistry.execute(action, dispatchParams);

        await sendAdeActionResult(correlationId, {
          success: result.success,
          message:
            result.message ??
            (result.success
              ? `Action "${action}" completed successfully`
              : `Action "${action}" failed`),
          data: result.data,
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        await sendAdeActionResult(correlationId, {
          success: false,
          message: `ADE action dispatch error: ${errorMessage}`,
        }).catch(() => {});
      }
    }

    window.addEventListener("agent-ade-action", handleADEAction);

    return () => {
      window.removeEventListener("agent-ade-action", handleADEAction);
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [
    activeWorkspaceRoot?.path,
    activeWorkspaceRoot?.repoId,
    activeWorkspaceRoot?.repo?.id,
  ]);
}
