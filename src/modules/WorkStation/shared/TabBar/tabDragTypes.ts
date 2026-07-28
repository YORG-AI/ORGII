import type { PillIconType } from "@src/components/ComposerInput";
import type { WorkStationTabType } from "@src/store/workstation/tabs";

export interface TabDragPillPayload {
  path: string;
  name?: string;
  iconType: PillIconType;
  isFolder?: boolean;
  tabType?: WorkStationTabType;
  contextText?: string;
  /** Second line for the drag ghost — owner, repo, whatever identifies it. */
  dragSubtitle?: string;
}

export interface TabDragEventDetail {
  tabId: string;
  filePath?: string;
  name?: string;
  type?: string;
  pill?: TabDragPillPayload;
  pointerX?: number;
  pointerY?: number;
}
