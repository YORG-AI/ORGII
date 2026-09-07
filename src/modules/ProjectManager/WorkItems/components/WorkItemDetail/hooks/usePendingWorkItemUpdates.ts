import { useCallback, useEffect, useMemo, useRef } from "react";

import { useKeyboardSave } from "@src/hooks/keyboard";
import { createLogger } from "@src/hooks/logger";
import { useUndoableState } from "@src/hooks/ui";
import type { WorkItem as WorkItemExtended } from "@src/types/core/workItem";

import type { WorkItemDetailActions, WorkItemUpdateHandler } from "../types";

const logger = createLogger("WorkItemDetail");

const IMMEDIATE_UPDATE_KEYS = ["status", "workItemStatus"] as const;

export function needsImmediateWorkItemUpdate(
  updates: Partial<WorkItemExtended>
): boolean {
  return IMMEDIATE_UPDATE_KEYS.some((key) => key in updates);
}

export function routeWorkItemUpdate(
  updates: Partial<WorkItemExtended>,
  handlers: {
    local?: (updates: Partial<WorkItemExtended>) => void;
    immediate?: (updates: Partial<WorkItemExtended>) => void;
  }
): void {
  if (needsImmediateWorkItemUpdate(updates)) {
    (handlers.immediate ?? handlers.local)?.(updates);
    return;
  }
  handlers.local?.(updates);
}

function sanitizePendingUpdates(
  updates: Partial<WorkItemExtended>
): Partial<WorkItemExtended> {
  const {
    status: _status,
    workItemStatus: _workItemStatus,
    executionLock: _executionLock,
    linkedSessions: _linkedSessions,
    orchestratorState: _orchestratorState,
    proofOfWork: _proofOfWork,
    ...safeUpdates
  } = updates;
  return safeUpdates;
}

interface PendingSnapshot {
  workItemId: string;
  updates: Partial<WorkItemExtended>;
}

interface UsePendingWorkItemUpdatesParams {
  workItem: WorkItemExtended;
  initialPendingUpdates?: Partial<WorkItemExtended>;
  onUpdateWorkItem?: WorkItemUpdateHandler;
  onPendingChangesChange?: (hasPending: boolean) => void;
  onRegisterActions?: (actions: WorkItemDetailActions) => void;
}

export function usePendingWorkItemUpdates({
  workItem,
  initialPendingUpdates,
  onUpdateWorkItem,
  onPendingChangesChange,
  onRegisterActions,
}: UsePendingWorkItemUpdatesParams) {
  const {
    state: pendingState,
    setState: setPendingState,
    reset: resetPending,
  } = useUndoableState<PendingSnapshot>(
    {
      workItemId: workItem.session_id,
      updates: initialPendingUpdates ?? {},
    },
    { keyboardShortcut: true }
  );

  const prevWorkItemIdRef = useRef(workItem.session_id);
  useEffect(() => {
    if (prevWorkItemIdRef.current !== workItem.session_id) {
      prevWorkItemIdRef.current = workItem.session_id;
      resetPending({ workItemId: workItem.session_id, updates: {} });
    }
  }, [workItem.session_id, resetPending]);

  const pendingUpdates = useMemo(
    () =>
      pendingState.workItemId === workItem.session_id
        ? sanitizePendingUpdates(pendingState.updates)
        : {},
    [pendingState, workItem.session_id]
  );
  const hasPendingChanges = Object.keys(pendingUpdates).length > 0;

  useEffect(() => {
    onPendingChangesChange?.(hasPendingChanges);
  }, [hasPendingChanges, onPendingChangesChange]);

  const displayWorkItem = useMemo<WorkItemExtended>(
    () => ({ ...workItem, ...pendingUpdates }),
    [workItem, pendingUpdates]
  );

  const handleLocalUpdate = useCallback(
    (updates: Partial<WorkItemExtended>) => {
      const safeUpdates = sanitizePendingUpdates(updates);
      setPendingState((prev) => ({
        workItemId: workItem.session_id,
        updates: sanitizePendingUpdates({
          ...(prev.workItemId === workItem.session_id ? prev.updates : {}),
          ...safeUpdates,
        }),
      }));
    },
    [workItem.session_id, setPendingState]
  );

  const handleImmediateUpdate = useCallback(
    (updates: Partial<WorkItemExtended>) => {
      onUpdateWorkItem?.(updates);
    },
    [onUpdateWorkItem]
  );

  const handleSave = useCallback(async () => {
    if (!hasPendingChanges || !onUpdateWorkItem) return;
    try {
      const result = onUpdateWorkItem(pendingUpdates);
      if (
        result != null &&
        typeof (result as Promise<unknown>).then === "function"
      ) {
        await result;
      }
      resetPending({ workItemId: workItem.session_id, updates: {} });
    } catch (err) {
      logger.error(
        `[handleSave] save failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }, [
    hasPendingChanges,
    pendingUpdates,
    onUpdateWorkItem,
    workItem.session_id,
    resetPending,
  ]);

  const handleCancel = useCallback(() => {
    resetPending({ workItemId: workItem.session_id, updates: {} });
  }, [workItem.session_id, resetPending]);

  useKeyboardSave(handleSave, hasPendingChanges);

  useEffect(() => {
    if (!hasPendingChanges) return;
    const timer = setTimeout(() => {
      handleSave();
    }, 800);
    return () => clearTimeout(timer);
  }, [hasPendingChanges, handleSave]);

  useEffect(() => {
    onRegisterActions?.({ save: handleSave, cancel: handleCancel });
  }, [handleSave, handleCancel, onRegisterActions]);

  return {
    displayWorkItem,
    pendingUpdates,
    hasPendingChanges,
    handleLocalUpdate,
    handleImmediateUpdate,
    handleSave,
  };
}
