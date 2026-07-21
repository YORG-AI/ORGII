import { useCallback, useEffect, useState } from "react";

import { rpc } from "@src/api/tauri/rpc";

import { selectInstalledCliAgents } from "../model";
import type { AvailableCliAgent } from "../types";

export function useInstalledCliAgents() {
  const [cliAgents, setCliAgents] = useState<AvailableCliAgent[]>([]);
  const fetchInstalledCliAgents = useCallback(async () => {
    const result = await rpc.agentOrgs.availableCliAgents();
    return selectInstalledCliAgents(result);
  }, []);
  const refreshInstalledCliAgents = useCallback(async () => {
    setCliAgents(await fetchInstalledCliAgents());
  }, [fetchInstalledCliAgents]);

  useEffect(() => {
    let cancelled = false;
    void fetchInstalledCliAgents()
      .then((installed) => {
        if (!cancelled) setCliAgents(installed);
      })
      .catch(() => {
        if (!cancelled) setCliAgents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [fetchInstalledCliAgents]);

  return { cliAgents, refreshInstalledCliAgents };
}
