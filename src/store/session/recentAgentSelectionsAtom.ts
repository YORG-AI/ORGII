import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

import type { CliAgentType } from "@src/api/tauri/rpc/schemas/validation";
import type { DispatchCategory } from "@src/api/tauri/session";

import {
  SESSION_TARGET_KIND,
  type SessionTargetKind,
} from "./creatorStateAtom";

const MAX_RECENT_AGENT_SELECTIONS = 3;
const STORAGE_KEY = "orgii:recentAgentSelections";

export interface RecentAgentSelection {
  category: DispatchCategory;
  targetKind: SessionTargetKind;
  agentDefinitionId?: string;
  agentOrgId?: string;
  cliAgentType?: CliAgentType;
}

function getRecentAgentSelectionKey(selection: RecentAgentSelection): string {
  if (selection.targetKind === SESSION_TARGET_KIND.AGENT_ORG) {
    return `org:${selection.agentOrgId ?? ""}`;
  }
  if (selection.category === "cli_agent" && selection.cliAgentType) {
    return `cli:${selection.cliAgentType}`;
  }
  if (selection.category === "cursor_ide") {
    return "cursor_ide";
  }
  if (selection.category === "human_session") {
    return "human_session";
  }
  return `agent:${selection.agentDefinitionId ?? ""}`;
}

export const recentAgentSelectionsAtom = atomWithStorage<
  RecentAgentSelection[]
>(STORAGE_KEY, []);

export const recordRecentAgentSelectionAtom = atom(
  null,
  (_get, set, selection: RecentAgentSelection) => {
    const selectionKey = getRecentAgentSelectionKey(selection);
    if (selectionKey.endsWith(":")) return;

    set(recentAgentSelectionsAtom, (previousSelections) => {
      const withoutSelection = previousSelections.filter(
        (previousSelection) =>
          getRecentAgentSelectionKey(previousSelection) !== selectionKey
      );
      return [selection, ...withoutSelection].slice(
        0,
        MAX_RECENT_AGENT_SELECTIONS
      );
    });
  }
);
recordRecentAgentSelectionAtom.debugLabel = "recordRecentAgentSelection";
