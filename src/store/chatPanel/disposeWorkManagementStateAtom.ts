import { atom } from "jotai";

import {
  kanbanReplayBoundsAtom,
  kanbanReplayCursorAtom,
  kanbanReplayEventsAtom,
  kanbanReplayModeAtom,
  kanbanReplayPlayingAtom,
  kanbanReplaySpeedAtom,
} from "@src/store/ui/kanbanReplayAtom";
import {
  kanbanDetailPanelVisibleAtom,
  kanbanFileSearchQueryAtom,
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
  set(kanbanFileSearchQueryAtom, "");
  set(kanbanReplayCursorAtom, null);
  set(kanbanReplayModeAtom, "follow");
  set(kanbanReplayBoundsAtom, { start: 0, end: 0 });
  set(kanbanReplayEventsAtom, []);
  set(kanbanReplayPlayingAtom, false);
  set(kanbanReplaySpeedAtom, 1);
});
disposeWorkManagementStateAtom.debugLabel = "disposeWorkManagementState";
