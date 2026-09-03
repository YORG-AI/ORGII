import { atom } from "jotai";

export const workManagementCreatorVisibleAtom = atom<boolean>(false);
workManagementCreatorVisibleAtom.debugLabel = "workManagement/creator/visible";

export const toggleWorkManagementCreatorVisibleAtom = atom(null, (get, set) => {
  set(workManagementCreatorVisibleAtom, !get(workManagementCreatorVisibleAtom));
});
toggleWorkManagementCreatorVisibleAtom.debugLabel =
  "workManagement/creator/toggleVisible";
