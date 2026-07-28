import { useCallback, useEffect, useState } from "react";

import { rpc } from "@src/api/tauri/rpc";

import type { OrgMember } from "../types";

const AGENT_ORGS_CHANGED_EVENT = "orgii-agent-orgs-changed";

export function useAgentOrgsDirectory() {
  const [orgs, setOrgs] = useState<OrgMember[]>([]);
  const [orgsLoading, setOrgsLoading] = useState(true);
  const loadOrgs = useCallback(() => rpc.agentOrgs.orgs.list(), []);

  useEffect(() => {
    let cancelled = false;
    void loadOrgs()
      .then((result) => {
        if (!cancelled) setOrgs(result);
      })
      .catch(() => {
        if (!cancelled) setOrgs([]);
      })
      .finally(() => {
        if (!cancelled) setOrgsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadOrgs]);

  useEffect(() => {
    const handleOrgsChanged = () => {
      void loadOrgs()
        .then(setOrgs)
        .catch(() => setOrgs([]));
    };
    window.addEventListener(AGENT_ORGS_CHANGED_EVENT, handleOrgsChanged);
    return () =>
      window.removeEventListener(AGENT_ORGS_CHANGED_EVENT, handleOrgsChanged);
  }, [loadOrgs]);

  return { orgs, setOrgs, orgsLoading, loadOrgs };
}
