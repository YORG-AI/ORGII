import { useAtomCallback } from "jotai/utils";
import { useCallback } from "react";

import type { AgentOrgRunMemberView } from "@src/api/tauri/agent";
import { CliAgentTypeSchema } from "@src/api/tauri/rpc/schemas/validation";
import { DISPATCH_CATEGORY, KEY_SOURCE } from "@src/api/tauri/session";
import { CLI_AGENT_PREFIX } from "@src/modules/MainApp/AgentOrgs/types";
import {
  activeSessionIdAtom,
  claimPipelineSessionAtom,
  sessionMapAtom,
} from "@src/store/session";
import {
  loadSidebarSessions,
  upsertSession,
} from "@src/store/session/sessionAtom";
import type { Session } from "@src/store/session/sessionAtom/types";
import { markSessionVisited } from "@src/store/session/visitedSessionsAtom";

function parseCliAgentType(cliAgentType: string | null | undefined) {
  const parsed = CliAgentTypeSchema.safeParse(cliAgentType);
  return parsed.success ? parsed.data : null;
}

function parseCliAgentOrgReference(agentReference: string | null | undefined) {
  if (!agentReference?.startsWith(CLI_AGENT_PREFIX)) return null;
  return parseCliAgentType(agentReference.slice(CLI_AGENT_PREFIX.length));
}

export interface AgentOrgMemberSessionIdentity {
  orgMemberId: string;
  parentSessionId?: string;
}

export function resolveAgentOrgMemberSessionIdentity(
  currentSessionId: string,
  member: AgentOrgRunMemberView
): AgentOrgMemberSessionIdentity | null {
  const runtime = member.sessionRuntime;
  if (!runtime) return null;

  return {
    orgMemberId: runtime.memberId ?? member.memberId,
    // Older Run View rows may omit the denormalized parent id. The page that
    // owns this member switcher is the canonical Root, so it is the correct
    // fallback for a child member. Never make the Root its own parent.
    parentSessionId:
      runtime.parentSessionId ??
      (runtime.sessionId === currentSessionId ? undefined : currentSessionId),
  };
}

export function needsAgentOrgMemberSessionIdentity(
  session: Pick<Session, "orgMemberId" | "parentSessionId">,
  identity: AgentOrgMemberSessionIdentity
): boolean {
  return (
    session.orgMemberId !== identity.orgMemberId ||
    session.parentSessionId !== identity.parentSessionId
  );
}

/**
 * Switch the chat pipeline to an Agent Team member's session without
 * touching WorkStation's remembered selection.
 *
 * The two-atom session model (see `viewAtom.ts`) separates the
 * pipeline (`activeSessionIdAtom`) from the WorkStation memory
 * (`workstationActiveSessionIdAtom`, persisted via `sessionViewAtom`).
 * Org member switching is a *secondary surface* claim — the user is
 * inspecting a child agent's stream inside the parent Org session, but
 * the docked sidebar selection and the ChatPanel header title should
 * stay anchored to the parent Org session they originally opened.
 *
 * We therefore mirror what `<ChatView secondary>` does for the kanban
 * detail panel: clear stale state, mark loading, swap the pipeline,
 * and mark visited — but leave `sessionViewAtom` alone so `usePanelTitle`
 * and the WorkstationSidebar keep showing the parent.
 */
export function useAgentOrgMemberSessionJump(currentSessionId: string) {
  // Read/write the pipeline atom inside the callback so we always compare
  // the freshest pipeline session id, not the stale value captured at
  // hook-creation time. Without this the coordinator's "All agents" entry
  // looks like a no-op when a child member is currently selected: the old
  // guard compared against the parent (`currentSessionId`) and the
  // coordinator's `sessionRuntime.sessionId` equals the parent, so the
  // jump always early-returned.
  return useAtomCallback(
    useCallback(
      (get, set, member: AgentOrgRunMemberView) => {
        const runtime = member.sessionRuntime;
        if (!runtime) return;
        const identity = resolveAgentOrgMemberSessionIdentity(
          currentSessionId,
          member
        );
        if (!identity) return;

        // Only register the session record when the store doesn't already
        // know about it. Re-upserting an existing session here would
        // shallow-merge the member's role-derived `name` ("Coordinator",
        // "Planner", …) over the authentic session name that came from
        // Rust's `session_aggregate_list` (e.g. the coordinator's
        // user-prompt-derived name like "Draft a contributing md"). That
        // clobbering is what causes the chat-panel header to flip to
        // "Coordinator" when the user jumps back to the root org session.
        const existing = get(sessionMapAtom).get(runtime.sessionId);
        if (!existing) {
          const cliAgentType =
            parseCliAgentType(runtime.cliAgentType) ??
            parseCliAgentOrgReference(runtime.agentDefinitionId);
          upsertSession({
            session_id: runtime.sessionId,
            status: runtime.status,
            created_at: runtime.updatedAt,
            updated_at: runtime.updatedAt,
            created_time: runtime.updatedAt,
            updated_time: runtime.updatedAt,
            name: member.name,
            is_active: true,
            category: cliAgentType
              ? DISPATCH_CATEGORY.CLI_AGENT
              : DISPATCH_CATEGORY.RUST_AGENT,
            keySource: KEY_SOURCE.OWN,
            cliAgentType: cliAgentType ?? undefined,
            orgMemberId: identity.orgMemberId,
            parentSessionId: identity.parentSessionId,
            agentDefinitionId: cliAgentType
              ? undefined
              : (runtime.agentDefinitionId ?? undefined),
          });
        } else if (needsAgentOrgMemberSessionIdentity(existing, identity)) {
          // A member row can already exist because sidebar/materialization ran
          // before Run View supplied its Agent Team identity. Preserve the
          // authentic backend-owned name and timestamps, but enrich the fields
          // that make the Member page a canonical direct-work target.
          upsertSession({
            ...existing,
            orgMemberId: identity.orgMemberId,
            parentSessionId: identity.parentSessionId,
          });
        }

        const pipelineSessionId = get(activeSessionIdAtom);
        if (runtime.sessionId === pipelineSessionId) return;
        set(claimPipelineSessionAtom, runtime.sessionId);
        markSessionVisited(runtime.sessionId);
        void loadSidebarSessions({ forceRefresh: true });
      },
      [currentSessionId]
    )
  );
}
