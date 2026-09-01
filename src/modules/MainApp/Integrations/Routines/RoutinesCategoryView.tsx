import React from "react";

import type { RoutineDefinition } from "@src/api/http/project";
import type { AgentDefinition } from "@src/modules/MainApp/AgentOrgs/types";
import RoutineWizard from "@src/scaffold/WizardSystem/variants/Policy/RoutineWizard";

import { RoutinesTable } from "./Table/RoutinesTable";
import type { RoutinesCategoryTableProps } from "./categoryTableProps";

export interface RoutinesDetailState {
  selectedRoutine: RoutineDefinition | undefined;
  wizardMode: boolean;
  editingRoutine: RoutineDefinition | undefined;
  agents: AgentDefinition[];
  onClose: () => void;
  onWizardSave: (routine: RoutineDefinition) => void;
  onWizardCancel: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onFire: () => void;
}

interface RoutinesCategoryViewProps {
  routines: RoutinesDetailState;
  tableProps: RoutinesCategoryTableProps;
  fullPage: boolean;
  onBack: () => void;
  onExpand?: () => void;
}

export const RoutinesCategoryView: React.FC<RoutinesCategoryViewProps> = ({
  routines,
  tableProps,
}) => {
  if (routines.wizardMode) {
    return (
      <RoutineWizard
        routine={routines.editingRoutine}
        agents={routines.agents}
        onSave={routines.onWizardSave}
        onCancel={routines.onWizardCancel}
      />
    );
  }

  const augmentedProps: RoutinesCategoryTableProps = {
    ...tableProps,
    selectedRowId: routines.selectedRoutine?.id ?? null,
    onEdit: routines.onEdit,
    onDelete: routines.onDelete,
    onToggleEnabled: routines.onToggleEnabled,
    onFire: routines.onFire,
  };

  return <RoutinesTable {...augmentedProps} />;
};
