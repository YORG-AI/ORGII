import { atom } from "jotai";

import {
  kanbanDetailPanelVisibleAtom,
  kanbanSearchQueryAtom,
  kanbanSelectedTaskIdAtom,
} from "@src/store/ui/kanbanViewStateAtom";
import { workManagementCreatorVisibleAtom } from "@src/store/ui/workManagementCreatorAtom";
import {
  WORK_MANAGEMENT_PROJECTS_VIEW,
  workManagementProjectsViewAtom,
  workstationTabHeaderAtomByHost,
} from "@src/store/workstation/workstationTabBarAtoms";

/** Release transient state that can retain the unmounted Kanban tree. */
export const disposeWorkManagementStateAtom = atom(null, (_get, set) => {
  set(workManagementCreatorVisibleAtom, false);
  set(workManagementProjectsViewAtom, WORK_MANAGEMENT_PROJECTS_VIEW.WORK_ITEMS);
  set(workstationTabHeaderAtomByHost.workManagement, null);

  set(kanbanSelectedTaskIdAtom, null);
  set(kanbanDetailPanelVisibleAtom, false);
  set(kanbanSearchQueryAtom, "");
});
disposeWorkManagementStateAtom.debugLabel = "disposeWorkManagementState";
