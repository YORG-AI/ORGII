import { listen } from "@tauri-apps/api/event";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  type RoutineDefinition,
  invalidateProjectCache,
  projectApi,
} from "@src/api/http/project";
import Message from "@src/components/Message";
import { WIZARD_IDS } from "@src/config/mainAppPaths";
import { useWizardParam } from "@src/hooks/navigation";
import {
  builtInAgentsAtom,
  customAgentsAtom,
} from "@src/modules/MainApp/AgentOrgs/store/builtInAgentsAtom";
import type { RoutinesDetailState } from "@src/modules/MainApp/Integrations/Routines/RoutinesCategoryView";

import type { DetailMode, IntegrationCategory } from "../types";

/** Fine-grained routine event emitted by the Rust backend. */
const ROUTINE_CHANGED_EVENT = "orgii-routine-changed";

export interface UseRoutinesStateReturn {
  routinesState: Omit<RoutinesDetailState, "onClose">;
  routines: RoutineDefinition[];
  routinesLoading: boolean;
  handleSelectRoutine: (id: string | null, mode?: DetailMode) => void;
  clearRoutinesState: () => void;
  openNewRoutineWizard: () => void;
  refreshRoutines: () => Promise<void>;
}

export function useRoutinesState(
  category: IntegrationCategory,
  setDetailMode: (mode: DetailMode) => void
): UseRoutinesStateReturn {
  const { t } = useTranslation("integrations");
  const routinesActive = category === "routines";
  const [routines, setRoutines] = useState<RoutineDefinition[]>([]);
  const [routinesLoading, setRoutinesLoading] = useState(false);
  const [selectedRoutineId, setSelectedRoutineId] = useState<string | null>(
    null
  );

  const refreshRoutines = useCallback(async () => {
    setRoutinesLoading(true);
    const nextRoutines = await projectApi.listRoutines();
    setRoutines(nextRoutines);
    setRoutinesLoading(false);
  }, []);

  useEffect(() => {
    if (!routinesActive) {
      return undefined;
    }

    const refreshTimer = window.setTimeout(() => {
      void refreshRoutines();
    }, 0);

    return () => window.clearTimeout(refreshTimer);
  }, [routinesActive, refreshRoutines]);

  // Live updates: scheduler fires / terminal write-backs happen entirely in
  // the backend, so the page must react to the fine-grained routine event.
  useEffect(() => {
    if (!routinesActive) return undefined;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen(ROUTINE_CHANGED_EVENT, () => {
      invalidateProjectCache("__routines__");
      void refreshRoutines();
    }).then((dispose) => {
      if (cancelled) {
        dispose();
      } else {
        unlisten = dispose;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [routinesActive, refreshRoutines]);

  const { wizard, entityId, openWizard, closeWizard } = useWizardParam();
  const routineWizardMode =
    wizard === WIZARD_IDS.ROUTINE_ADD || wizard === WIZARD_IDS.ROUTINE_EDIT;
  const editingRoutineId = wizard === WIZARD_IDS.ROUTINE_EDIT ? entityId : null;

  const selectedRoutine = useMemo(
    () => routines.find((routine) => routine.id === selectedRoutineId),
    [routines, selectedRoutineId]
  );

  const editingRoutine = useMemo(
    () =>
      editingRoutineId
        ? routines.find((routine) => routine.id === editingRoutineId)
        : undefined,
    [editingRoutineId, routines]
  );

  const builtInAgents = useAtomValue(builtInAgentsAtom);
  const customAgents = useAtomValue(customAgentsAtom);
  const allAgents = useMemo(
    () => [...builtInAgents, ...customAgents],
    [builtInAgents, customAgents]
  );

  const clearRoutinesState = useCallback(() => {
    setSelectedRoutineId(null);
    closeWizard();
  }, [closeWizard]);

  const handleSelectRoutine = useCallback(
    (id: string | null, mode?: DetailMode) => {
      setSelectedRoutineId(id);
      closeWizard();
      setDetailMode(mode ?? "preview");
    },
    [setDetailMode, closeWizard]
  );

  const handleWizardSave = useCallback(
    async (routine: RoutineDefinition) => {
      const savedRoutine = await projectApi.upsertRoutine(routine);
      await refreshRoutines();
      closeWizard();
      setSelectedRoutineId(savedRoutine.id);
    },
    [refreshRoutines, closeWizard]
  );

  const handleWizardCancel = useCallback(() => {
    closeWizard();
  }, [closeWizard]);

  const handleEdit = useCallback(() => {
    if (selectedRoutine) {
      openWizard(WIZARD_IDS.ROUTINE_EDIT, selectedRoutine.id);
    }
  }, [selectedRoutine, openWizard]);

  const handleDelete = useCallback(async () => {
    if (!selectedRoutine) return;
    await projectApi.deleteRoutine(selectedRoutine.id);
    await refreshRoutines();
    setSelectedRoutineId(null);
    closeWizard();
  }, [selectedRoutine, refreshRoutines, closeWizard]);

  const handleToggle = useCallback(
    async (enabled: boolean) => {
      if (!selectedRoutine) return;
      await projectApi.upsertRoutine({ ...selectedRoutine, enabled });
      await refreshRoutines();
    },
    [selectedRoutine, refreshRoutines]
  );

  const handleFire = useCallback(async () => {
    if (!selectedRoutine) return;
    try {
      const result = await projectApi.fireRoutine(selectedRoutine.id);
      await refreshRoutines();
      if (
        result.fire.status === "queued" ||
        result.fire.status === "coalesced" ||
        result.fire.status === "skipped"
      ) {
        Message.info(
          t("routineFields.fireAccepted", {
            defaultValue: `Run ${result.fire.status}`,
          })
        );
      } else {
        Message.success(
          t("routineFields.fireStarted", {
            defaultValue: "Routine run started",
          })
        );
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      Message.error(
        t("routineFields.fireError", {
          defaultValue: `Could not start the Routine: ${detail}`,
        }),
        5000
      );
    }
  }, [selectedRoutine, refreshRoutines, t]);

  const openNewRoutineWizard = useCallback(() => {
    openWizard(WIZARD_IDS.ROUTINE_ADD);
  }, [openWizard]);

  const routinesState: Omit<RoutinesDetailState, "onClose"> = useMemo(
    () => ({
      selectedRoutine,
      wizardMode: routineWizardMode,
      editingRoutine,
      agents: allAgents,
      onWizardSave: handleWizardSave,
      onWizardCancel: handleWizardCancel,
      onEdit: handleEdit,
      onDelete: handleDelete,
      onToggleEnabled: handleToggle,
      onFire: handleFire,
    }),
    [
      selectedRoutine,
      routineWizardMode,
      editingRoutine,
      allAgents,
      handleWizardSave,
      handleWizardCancel,
      handleEdit,
      handleDelete,
      handleToggle,
      handleFire,
    ]
  );

  return {
    routinesState,
    routines,
    routinesLoading,
    handleSelectRoutine,
    clearRoutinesState,
    openNewRoutineWizard,
    refreshRoutines,
  };
}
