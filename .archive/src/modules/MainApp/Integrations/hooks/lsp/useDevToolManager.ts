/**
 * useDevToolManager — generic hook for LSP-style tool management.
 *
 * Encapsulates the shared lifecycle used by both `useLanguageServers` (LSP)
 * and `useLintTools` (linters):
 *   • cache-first load (cached invoke → network refresh)
 *   • per-item action state machine (idle → installing/uninstalling → success/failed)
 *   • auto-reset timers after success/failure
 *   • workspace enable/disable toggle
 *   • mounted-ref guard on all async paths
 *
 * Callers bind the Tauri invoke names and the optional `stateKeyPrefix` at
 * the call site so the generic implementation stays domain-agnostic.
 */
import { TerminalService } from "@/src/services/terminal";
import { invoke } from "@tauri-apps/api/core";
import { useSetAtom } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";

import { useMountedCleanup } from "@src/hooks/lifecycle/useMounted";
import { createLogger } from "@src/hooks/logger";
import type {
  ActionState,
  InstallCommandResult,
  UninstallCommandResult,
} from "@src/modules/MainApp/Integrations/DevTools/LanguageServersPage/types";
import { invalidateDepsAtom } from "@src/store/platform/systemDepsAtom";

const log = createLogger("DevToolManager");

const SUCCESS_AUTO_HIDE = 10000;
const FAILED_AUTO_HIDE = 8000;

/**
 * Shape that both LSP and Lint workspace configs share.
 * Mirrors Rust `WorkspaceLspConfig` / `WorkspaceLintConfig` (one field).
 * "Enabled" is the absence of a row in `disabled` — there is no positive
 * `enabled[]` list on either side of the wire.
 */
interface WorkspaceConfig {
  disabled: string[];
}

export interface UseDevToolManagerOptions {
  workspacePath: string | null;
  executeInTerminal?: (command: string) => Promise<void>;

  /** Tauri commands — all names must be bound by the caller. */
  invokeNames: {
    getCached: string;
    checkInstalled: string;
    getWorkspaceConfig: string;
    setItemEnabled: string;
    getInstallCommand: string;
    getUninstallCommand: string;
  };

  /**
   * Payload key used for `setItemEnabled` and `get*Command` invocations.
   * LSP uses "language", lint uses "toolId".
   */
  itemParamName: string;

  /**
   * Optional prefix prepended to every `actionStates` map key.
   * e.g. "lint_" ensures lint tool IDs never collide with LSP language IDs
   * if both hooks were used in the same component.
   */
  stateKeyPrefix?: string;
}

export interface UseDevToolManagerResult<TItem> {
  items: TItem[];
  isLoading: boolean;
  isRefreshing: boolean;
  workspaceConfig: WorkspaceConfig | null;
  getActionState: (id: string) => ActionState;
  handleInstall: (id: string) => Promise<void>;
  handleUninstall: (id: string) => Promise<void>;
  handleWorkspaceToggle: (id: string, enabled: boolean) => Promise<void>;
  isItemEnabled: (id: string) => boolean;
  clearActionState: (id: string) => void;
  refresh: () => void;
}

export function useDevToolManager<TItem>({
  workspacePath,
  executeInTerminal,
  invokeNames,
  itemParamName,
  stateKeyPrefix = "",
}: UseDevToolManagerOptions): UseDevToolManagerResult<TItem> {
  const runCommand = executeInTerminal ?? TerminalService.execute;
  const invalidateDeps = useSetAtom(invalidateDepsAtom);
  const [items, setItems] = useState<TItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [actionStates, setActionStates] = useState<Record<string, ActionState>>(
    {}
  );
  const [workspaceConfig, setWorkspaceConfig] =
    useState<WorkspaceConfig | null>(null);
  const mountedRef = useRef(true);
  useMountedCleanup(mountedRef);
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  const stateKey = useCallback(
    (id: string) => `${stateKeyPrefix}${id}`,
    [stateKeyPrefix]
  );

  const fetchItems = useCallback(async () => {
    setIsRefreshing(true);
    try {
      const result = await invoke<TItem[]>(invokeNames.checkInstalled);
      if (mountedRef.current) setItems(result);
    } catch (error) {
      log.error(
        `[DevToolManager:${invokeNames.checkInstalled}] Failed:`,
        error
      );
    } finally {
      if (mountedRef.current) {
        setIsRefreshing(false);
        setIsLoading(false);
      }
    }
  }, [invokeNames.checkInstalled, mountedRef]);

  const fetchWorkspaceConfig = useCallback(async () => {
    if (!workspacePath) {
      setWorkspaceConfig(null);
      return;
    }
    try {
      const config = await invoke<WorkspaceConfig>(
        invokeNames.getWorkspaceConfig,
        { workspacePath }
      );
      if (mountedRef.current) setWorkspaceConfig(config);
    } catch (error) {
      log.error(
        `[DevToolManager:${invokeNames.getWorkspaceConfig}] Failed:`,
        error
      );
      if (mountedRef.current) setWorkspaceConfig(null);
    }
  }, [workspacePath, invokeNames.getWorkspaceConfig, mountedRef]);

  useEffect(() => {
    let cancelled = false;

    invoke<TItem[]>(invokeNames.getCached)
      .then((cached) => {
        if (cancelled) return;
        if ((cached as TItem[]).length > 0) {
          setItems(cached);
          setIsLoading(false);
        }
      })
      .catch((err: unknown) => {
        // Cache miss is non-fatal — the live `fetchItems()` below still
        // populates the table. Surface the failure for debugging instead
        // of silently swallowing it.
        log.warn(
          `[DevToolManager:${invokeNames.getCached}] cache load failed:`,
          err
        );
      });

    fetchItems();
    fetchWorkspaceConfig();

    const timers = timersRef.current;
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
      timers.clear();
    };
  }, [fetchItems, fetchWorkspaceConfig, invokeNames.getCached]);

  const scheduleReset = useCallback(
    (key: string, delayMs: number) => {
      const timer = setTimeout(() => {
        timersRef.current.delete(timer);
        if (mountedRef.current) {
          setActionStates((prev) => ({ ...prev, [key]: { status: "idle" } }));
        }
      }, delayMs);
      timersRef.current.add(timer);
    },
    [mountedRef]
  );

  const handleInstall = useCallback(
    async (id: string) => {
      const key = stateKey(id);
      setActionStates((prev) => {
        if (
          prev[key]?.status === "installing" ||
          prev[key]?.status === "uninstalling"
        )
          return prev;
        return {
          ...prev,
          [key]: {
            status: "installing",
            action: "install",
            startTime: Date.now(),
          },
        };
      });

      try {
        const result = await invoke<InstallCommandResult>(
          invokeNames.getInstallCommand,
          { [itemParamName]: id }
        );
        if (!mountedRef.current) return;

        if (result.command) {
          setActionStates((prev) => ({
            ...prev,
            [key]: { ...prev[key], command: result.command },
          }));
          await runCommand(result.command);
          if (!mountedRef.current) return;
          setActionStates((prev) => ({
            ...prev,
            [key]: { ...prev[key], status: "success" },
          }));
          fetchItems();
          invalidateDeps();
          scheduleReset(key, SUCCESS_AUTO_HIDE);
        } else {
          setActionStates((prev) => ({
            ...prev,
            [key]: {
              ...prev[key],
              status: "failed",
              errorMessage: result.error || "No install command available",
            },
          }));
          scheduleReset(key, FAILED_AUTO_HIDE);
        }
      } catch (error) {
        log.error(`[DevToolManager:install] Failed:`, error);
        if (!mountedRef.current) return;
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        setActionStates((prev) => ({
          ...prev,
          [key]: { ...prev[key], status: "failed", errorMessage },
        }));
        scheduleReset(key, FAILED_AUTO_HIDE);
      }
    },
    [
      fetchItems,
      invalidateDeps,
      runCommand,
      scheduleReset,
      stateKey,
      invokeNames.getInstallCommand,
      itemParamName,
      mountedRef,
    ]
  );

  const handleUninstall = useCallback(
    async (id: string) => {
      const key = stateKey(id);
      setActionStates((prev) => {
        if (
          prev[key]?.status === "installing" ||
          prev[key]?.status === "uninstalling"
        )
          return prev;
        return {
          ...prev,
          [key]: {
            status: "uninstalling",
            action: "uninstall",
            startTime: Date.now(),
          },
        };
      });

      try {
        const result = await invoke<UninstallCommandResult>(
          invokeNames.getUninstallCommand,
          { [itemParamName]: id }
        );
        if (!mountedRef.current) return;

        if (result.command && result.uninstallSupported) {
          setActionStates((prev) => ({
            ...prev,
            [key]: { ...prev[key], command: result.command },
          }));
          await runCommand(result.command);
          if (!mountedRef.current) return;
          setActionStates((prev) => ({
            ...prev,
            [key]: { ...prev[key], status: "success" },
          }));
          fetchItems();
          invalidateDeps();
          scheduleReset(key, SUCCESS_AUTO_HIDE);
        } else {
          log.warn(`[DevToolManager:uninstall] Not supported:`, result.error);
          setActionStates((prev) => ({
            ...prev,
            [key]: {
              ...prev[key],
              status: "failed",
              errorMessage: result.error || "Uninstall not supported",
            },
          }));
          scheduleReset(key, FAILED_AUTO_HIDE);
        }
      } catch (error) {
        log.error(`[DevToolManager:uninstall] Failed:`, error);
        if (!mountedRef.current) return;
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        setActionStates((prev) => ({
          ...prev,
          [key]: { ...prev[key], status: "failed", errorMessage },
        }));
        scheduleReset(key, FAILED_AUTO_HIDE);
      }
    },
    [
      fetchItems,
      invalidateDeps,
      runCommand,
      scheduleReset,
      stateKey,
      invokeNames.getUninstallCommand,
      itemParamName,
      mountedRef,
    ]
  );

  const handleWorkspaceToggle = useCallback(
    async (id: string, enabled: boolean) => {
      if (!workspacePath) return;
      try {
        await invoke(invokeNames.setItemEnabled, {
          workspacePath,
          [itemParamName]: id,
          enabled,
        });
        setWorkspaceConfig((prev) => {
          if (!prev) return prev;
          const newDisabled = enabled
            ? prev.disabled.filter((x) => x !== id)
            : [...prev.disabled, id];
          return { disabled: newDisabled };
        });
      } catch (error) {
        log.error(`[DevToolManager:workspaceToggle] Failed:`, error);
        // Resync from backend so the UI doesn't show a phantom toggle that
        // never persisted (F6: surface workspace-toggle failures).
        await fetchWorkspaceConfig();
        throw error;
      }
    },
    [
      workspacePath,
      invokeNames.setItemEnabled,
      itemParamName,
      fetchWorkspaceConfig,
    ]
  );

  const isItemEnabled = useCallback(
    (id: string) => {
      if (!workspaceConfig) return true;
      return !workspaceConfig.disabled.includes(id);
    },
    [workspaceConfig]
  );

  const getActionState = useCallback(
    (id: string): ActionState => {
      return actionStates[stateKey(id)] || { status: "idle" };
    },
    [actionStates, stateKey]
  );

  const clearActionState = useCallback(
    (id: string) => {
      const key = stateKey(id);
      setActionStates((prev) => ({ ...prev, [key]: { status: "idle" } }));
    },
    [stateKey]
  );

  const refresh = useCallback(() => {
    fetchItems();
    fetchWorkspaceConfig();
  }, [fetchItems, fetchWorkspaceConfig]);

  return {
    items,
    isLoading,
    isRefreshing,
    workspaceConfig,
    getActionState,
    handleInstall,
    handleUninstall,
    handleWorkspaceToggle,
    isItemEnabled,
    clearActionState,
    refresh,
  };
}
