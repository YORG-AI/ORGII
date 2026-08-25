import { atom } from "jotai";

import { openSessionInWorkstationAtom } from "@src/store/session/sessionTabPlacementAtom";
import { chatPanelMaximizedAtom } from "@src/store/ui/chatPanelAtom";
import { STATION_MODE, stationModeAtom } from "@src/store/ui/simulatorAtom";
import {
  type WorkStationTab,
  githubIssueDetailTabFactory,
  githubPrDetailTabFactory,
  openWorkstationTabAtom,
  presentedWorkstationWorkspaceKeyAtom,
} from "@src/store/workstation/tabs";

import { closeChatPanelTabAtom } from "./chatPanelTabLifecycleAtoms";
import type { ChatPanelTab, ChatPanelTabType } from "./chatPanelTabsModel";
import { chatPanelTabsAtom } from "./chatPanelTabsState";

type WorkstationTransferKind = "session" | "github-issue" | "github-pr";

/**
 * Lossless Chat Panel -> My Station mappings. The record is exhaustive so a
 * new Chat Panel tab type must make an explicit transfer decision.
 */
const WORKSTATION_TRANSFER_KIND: Record<
  ChatPanelTabType,
  WorkstationTransferKind | null
> = {
  session: "session",
  terminal: null,
  "start-page": null,
  runtime: null,
  "team-inbox": null,
  "work-management": null,
  workspace: null,
  organization: null,
  "work-item": null,
  "github-issue": "github-issue",
  "github-pr": "github-pr",
  project: null,
  explore: null,
  channel: null,
  "run-group": null,
};

export function canMoveChatPanelTabToWorkstation(
  tab: ChatPanelTab | undefined
): boolean {
  if (!tab) return false;

  switch (WORKSTATION_TRANSFER_KIND[tab.type]) {
    case "session":
      return Boolean(tab.sessionId?.trim());
    case "github-issue":
      return tab.githubIssue !== undefined;
    case "github-pr":
      return tab.githubPr !== undefined;
    case null:
      return false;
  }
}

function createWorkstationDetailTab(tab: ChatPanelTab): WorkStationTab | null {
  switch (WORKSTATION_TRANSFER_KIND[tab.type]) {
    case "github-issue":
      return tab.githubIssue
        ? githubIssueDetailTabFactory(tab.githubIssue)
        : null;
    case "github-pr":
      return tab.githubPr ? githubPrDetailTabFactory(tab.githubPr) : null;
    case "session":
    case null:
      return null;
  }
}

/** Move one losslessly representable Chat Panel tab into My Station. */
export const moveChatPanelTabToWorkstationAtom = atom(
  null,
  (get, set, tabId: string): boolean => {
    const tab = get(chatPanelTabsAtom).tabs.find(
      (candidate) => candidate.id === tabId
    );
    if (!tab || !canMoveChatPanelTabToWorkstation(tab)) return false;

    if (tab.type === "session" && tab.sessionId) {
      return set(openSessionInWorkstationAtom, {
        sessionId: tab.sessionId,
        title: tab.title,
      });
    }

    const workstationTab = createWorkstationDetailTab(tab);
    if (!workstationTab) return false;

    set(openWorkstationTabAtom, {
      workspace: get(presentedWorkstationWorkspaceKeyAtom),
      tab: workstationTab,
    });
    set(closeChatPanelTabAtom, tab.id);
    set(chatPanelMaximizedAtom, false);
    set(stationModeAtom, STATION_MODE.MY_STATION);
    return true;
  }
);
moveChatPanelTabToWorkstationAtom.debugLabel = "moveChatPanelTabToWorkstation";
