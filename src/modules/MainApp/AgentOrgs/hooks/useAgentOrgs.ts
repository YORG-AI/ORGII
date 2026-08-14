/**
 * useAgentOrgs — read-only hook to load agent teams via Tauri invoke.
 *
 * Returns the list of OrgMember (top-level org definitions) for use in
 * assignee pickers and orchestrator config resolution.
 */
import { useCallback } from "react";

import { rpc } from "@src/api/tauri/rpc";
import { useAsyncResource } from "@src/hooks/async";
import { createLogger } from "@src/hooks/logger";

import type { OrgMember } from "../types";

const log = createLogger("AgentOrgs");

export function useAgentOrgs() {
  const fetchOrgs = useCallback(async () => {
    try {
      return await rpc.agentOrgs.orgs.list();
    } catch (error) {
      log.error("[AgentOrgs] Failed to fetch:", error);
      throw error;
    }
  }, []);
  const resource = useAsyncResource<OrgMember[]>({
    fetcher: fetchOrgs,
    initialData: [],
    scopeKey: "agent-orgs",
  });

  return {
    orgs: resource.data,
    loading: resource.loading,
    refresh: resource.refresh,
  };
}
