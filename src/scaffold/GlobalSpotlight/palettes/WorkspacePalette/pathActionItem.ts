import { ICONS } from "../../config";
import type { SpotlightItem } from "../../types";
import {
  getWorkspacePathCandidate,
  getWorkspacePathDisplayName,
} from "./pathImport";

interface BuildOpenPathItemArgs {
  searchQuery: string;
  addLabel: string;
  onOpenPath: (candidatePath: string) => void;
}

export function buildOpenPathItem({
  searchQuery,
  addLabel,
  onOpenPath,
}: BuildOpenPathItemArgs): SpotlightItem | null {
  const candidatePath = getWorkspacePathCandidate(searchQuery);
  if (!candidatePath) return null;

  const folderName = getWorkspacePathDisplayName(candidatePath);

  return {
    id: "repo-open-path-candidate",
    label: `${addLabel} "${folderName}"`,
    desc: candidatePath,
    icon: ICONS.folder,
    type: "action",
    data: {
      contextMenuCopy: { name: folderName, path: candidatePath },
    },
    action: () => onOpenPath(candidatePath),
  };
}
