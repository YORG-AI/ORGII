/**
 * Hook for fetching CLI agents and performing install/uninstall/detect actions.
 */
import { invoke } from "@tauri-apps/api/core";
import { useSetAtom } from "jotai";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import { autoDetectKey } from "@src/api/services/keyValidation";
import type { ModelType } from "@src/api/types/keys";
import Message from "@src/components/Message";
import type { AgentAction, AvailableAgent } from "@src/config/cliAgents";
import { useAsyncResource } from "@src/hooks/async";
import { TerminalService } from "@src/services/terminal/TerminalService";
import { invalidateDepsAtom } from "@src/store/platform/systemDepsAtom";

export interface UseCliAgentsOptions {
  /** When false, skips the initial fetch (no Tauri IPC on mount). */
  enabled?: boolean;
}

const EMPTY_CLI_AGENTS: AvailableAgent[] = [];

export function useCliAgents({ enabled = true }: UseCliAgentsOptions = {}) {
  const { t } = useTranslation("settings");
  const [actionMap, setActionMap] = useState<Record<string, AgentAction>>({});
  const executeInTerminal = TerminalService.execute;
  const invalidateDeps = useSetAtom(invalidateDepsAtom);

  const loadAgents = useCallback(async () => {
    const raw = await invoke<AvailableAgent[]>("get_available_agents");
    return [...raw].sort((agentA, agentB) => {
      const installedDiff = Number(agentB.installed) - Number(agentA.installed);
      if (installedDiff !== 0) return installedDiff;
      return agentA.displayName.localeCompare(agentB.displayName);
    });
  }, []);
  const resource = useAsyncResource({
    enabled,
    fetcher: loadAgents,
    initialData: EMPTY_CLI_AGENTS,
    scopeKey: enabled ? "cli-agents" : null,
  });
  const fetchAgents = resource.refresh;

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
    agents: resource.data,
    loading: resource.loading,
    error: resource.error,
    actionMap,
    fetchAgents,
    handleInstall,
    handleUninstall,
    handleDetect,
  };
}
