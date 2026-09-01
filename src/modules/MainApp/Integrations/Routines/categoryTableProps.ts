import type { ComponentProps } from "react";

import type { AddAction } from "../types";
import type { RoutinesTable } from "./Table/RoutinesTable";

export type RoutinesCategoryTableProps = ComponentProps<typeof RoutinesTable>;

export function getRoutinesCategoryTableProps(params: {
  routines: {
    routines: RoutinesCategoryTableProps["routines"];
    routinesLoading: boolean;
    handleSelectRoutine: RoutinesCategoryTableProps["onSelectRoutine"];
  };
  onAddAction: (action: AddAction) => void;
}): RoutinesCategoryTableProps {
  return {
    routines: params.routines.routines,
    loading: params.routines.routinesLoading,
    onSelectRoutine: params.routines.handleSelectRoutine,
    onAdd: () => params.onAddAction("add-routine"),
  };
}
