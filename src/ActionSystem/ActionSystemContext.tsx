/**
 * ActionSystemContext
 *
 * React context that provides the action dispatcher to all components.
 * Unifies human clicks and AI commands through the same dispatch pipeline.
 */
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
} from "react";

import {
  cleanupServices,
  initializeServices,
  registerCoreActions,
} from "@src/modules/WorkStation/ActionSystem/registration/registerCoreActions";
// Deep import: the `@src/services` barrel re-exports EditorService, whose
// static @codemirror/* imports would otherwise ride into the startup graph
// through this app-lifetime provider.
import { GUIAgentService } from "@src/services/guiAgent/GUIAgentService";

import type { ActionResult } from "./schema/defineZodAction";
import { zodActionRegistry } from "./schema/zodRegistry";

export interface TypedDispatch {
  (
    type: string,
    payload?: Record<string, unknown>,
    source?: "user" | "ai" | "system"
  ): Promise<ActionResult>;
}

export interface ActionSystemContextValue {
  dispatch: TypedDispatch;
  getActionIds: () => string[];
  isValidAction: (type: string) => boolean;
}

export interface ActionSystemProviderProps {
  children: ReactNode;
  repoPath: string;
  repoId?: string;
}

const ActionSystemContext = createContext<ActionSystemContextValue | null>(
  null
);

export function ActionSystemProvider({
  children,
  repoPath,
  repoId,
}: ActionSystemProviderProps) {
  useEffect(() => {
    let cleanupFn: (() => void) | null = null;

    const scheduleIdle =
      typeof requestIdleCallback === "function"
        ? requestIdleCallback
        : (callback: () => void) => setTimeout(callback, 50);

    const cancelIdle =
      typeof cancelIdleCallback === "function"
        ? cancelIdleCallback
        : clearTimeout;

    const idleHandle = scheduleIdle(() => {
      initializeServices(repoPath, repoId).then(() => {});
      cleanupFn = registerCoreActions(repoPath);
    });

    return () => {
      cancelIdle(idleHandle as number);
      cleanupFn?.();
      cleanupServices();
    };
  }, [repoPath, repoId]);

  const dispatch = useCallback(
    async (
      type: string,
      payload: Record<string, unknown> = {},
      source: "user" | "ai" | "system" = "user"
    ): Promise<ActionResult> => {
      GUIAgentService.logAction(type, payload, source);

      const startTime = performance.now();

      try {
        const result = await zodActionRegistry.execute(type, payload);
        const duration = performance.now() - startTime;
        GUIAgentService.logResult(type, result, duration);

        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        GUIAgentService.logError(type, error);

        return { success: false, message };
      }
    },
    []
  );

  const getActionIds = useCallback(() => {
    return zodActionRegistry.getActionIds();
  }, []);

  const isValidAction = useCallback((type: string): boolean => {
    return zodActionRegistry.has(type);
  }, []);

  const value = useMemo(
    () => ({
      dispatch,
      getActionIds,
      isValidAction,
    }),
    [dispatch, getActionIds, isValidAction]
  );

  return (
    <ActionSystemContext.Provider value={value}>
      {children}
    </ActionSystemContext.Provider>
  );
}

export function useActionSystem(): ActionSystemContextValue {
  const ctx = useContext(ActionSystemContext);
  if (!ctx) {
    throw new Error("useActionSystem must be used within ActionSystemProvider");
  }
  return ctx;
}

export function useActionSystemOptional(): ActionSystemContextValue | null {
  return useContext(ActionSystemContext);
}
