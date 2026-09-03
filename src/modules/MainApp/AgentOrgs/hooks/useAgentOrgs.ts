/**
 * useAgentOrgs — read-only hook to load agent teams via Tauri invoke.
 *
 * Returns the list of OrgDefinition (top-level org definitions) for use in
 * assignee pickers and orchestrator config resolution.
 */
import { useCallback, useEffect, useState } from "react";

import { rpc } from "@src/api/tauri/rpc";
import { useMounted } from "@src/hooks/lifecycle/useMounted";
import { createLogger } from "@src/hooks/logger";

import type { OrgDefinition } from "../types";

const log = createLogger("AgentOrgs");

export function useAgentOrgs() {
  const [orgs, setOrgs] = useState<OrgDefinition[]>([]);
  const [loading, setLoading] = useState(false);
  const mountedRef = useMounted();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await rpc.agentOrgs.orgs.list();
      if (mountedRef.current) setOrgs(result);
    } catch (error) {
      log.error("[AgentOrgs] Failed to fetch:", error);
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [mountedRef]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      try {
        const result = await rpc.agentOrgs.orgs.list();
        if (!cancelled) setOrgs(result);
      } catch (error) {
        log.error("[AgentOrgs] Failed to fetch:", error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();

    return () => {
      cancelled = true;
    };
  }, []);

  return { orgs, loading, refresh };
}
