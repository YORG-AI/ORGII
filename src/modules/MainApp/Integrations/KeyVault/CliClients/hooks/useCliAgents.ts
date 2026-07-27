/**
 * Hook for fetching CLI agents and performing install/uninstall/detect actions.
 */
import { useSetAtom } from "jotai";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { loadAvailableAgents } from "@src/api/services/availableAgents";
import { autoDetectKey } from "@src/api/services/keyValidation";
import type { ModelType } from "@src/api/types/keys";
import Message from "@src/components/Message";
import type { AgentAction, AvailableAgent } from "@src/config/cliAgents";
import { TerminalService } from "@src/services/terminal/TerminalService";
import { invalidateDepsAtom } from "@src/store/platform/systemDepsAtom";

export interface UseCliAgentsOptions {
  /** When false, skips the initial fetch (no Tauri IPC on mount). */
  enabled?: boolean;
}

export function useCliAgents({ enabled = true }: UseCliAgentsOptions = {}) {
  const { t } = useTranslation("settings");
  const [agents, setAgents] = useState<AvailableAgent[]>([]);
  // Start false so remounts triggered by `enabled` flips (e.g. the
  // Integrations models tab toggling on navigation) don't paint a
  // spinner before the IPC begins. `fetchAgents` below flips it true
  // for the actual fetch window.
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionMap, setActionMap] = useState<Record<string, AgentAction>>({});
  const executeInTerminal = TerminalService.execute;
  const invalidateDeps = useSetAtom(invalidateDepsAtom);

  const fetchAgents = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const raw = await loadAvailableAgents();
      const sorted = [...raw].sort((agentA, agentB) => {
        const installedDiff =
          Number(agentB.installed) - Number(agentA.installed);
        if (installedDiff !== 0) return installedDiff;
        return agentA.displayName.localeCompare(agentB.displayName);
      });
      setAgents(sorted);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) fetchAgents();
  }, [enabled, fetchAgents]);

  const handleInstall = useCallback(
    async (agentName: string, installCmd?: string) => {
      if (!installCmd) return;

      setActionMap((prev) => ({ ...prev, [agentName]: "installing" }));

      try {
        await executeInTerminal(installCmd);
        await fetchAgents();
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        Message.error({
          content: errorMessage,
          duration: 5000,
          closable: true,
        });
      } finally {
        setActionMap((prev) => ({ ...prev, [agentName]: null }));
        invalidateDeps();
      }
    },
    [executeInTerminal, fetchAgents, invalidateDeps]
  );

  const handleUninstall = useCallback(
    async (agentName: string, uninstallCmd?: string) => {
      if (!uninstallCmd) return;

      setActionMap((prev) => ({ ...prev, [agentName]: "installing" }));

      try {
        await executeInTerminal(uninstallCmd);
        await fetchAgents();
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        Message.error({
          content: errorMessage,
          duration: 5000,
          closable: true,
        });
      } finally {
        setActionMap((prev) => ({ ...prev, [agentName]: null }));
        invalidateDeps();
      }
    },
    [executeInTerminal, fetchAgents, invalidateDeps]
  );

  const handleDetect = useCallback(
    async (agentName: string) => {
      setActionMap((prev) => ({ ...prev, [agentName]: "detecting" }));
      try {
        await autoDetectKey(agentName as ModelType);
        await fetchAgents();
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        Message.error({
          content: errorMessage,
          duration: 5000,
          closable: true,
          cancel: {
            label: t("common:actions.cancel"),
          },
          download: {
            fileName: `agent-cli-${agentName}-credential-error.txt`,
            content: errorMessage,
          },
        });
      } finally {
        setActionMap((prev) => ({ ...prev, [agentName]: null }));
      }
    },
    [fetchAgents, t]
  );

  return {
    agents,
    loading,
    error,
    actionMap,
    fetchAgents,
    handleInstall,
    handleUninstall,
    handleDetect,
  };
}
