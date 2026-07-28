/**
 * globalSpotlight.helpers
 *
 * Pure helper functions and small local types consumed by
 * `GlobalSpotlightInner` in `index.tsx`. Extracted verbatim to keep the
 * root component file within the repo's ~600-line soft limit — no
 * behavior changes.
 */
import { slugFragment } from "@src/features/SessionCreator/components/worktreeSmartInput";
import type { WorktreeLaunchSource } from "@src/store/session/worktreeLaunchSourceAtom";

import type { EditorPaletteMode } from "./palettes/EditorPalette/types";

export type WorkspacePickerMode = "switch" | "open" | "add" | "create";

export interface EmbeddedEditorPaletteState {
  mode: EditorPaletteMode;
  query: string;
}

export function getEditorPaletteMode(query: string): EditorPaletteMode {
  if (query.startsWith(">")) return "command";
  if (query.startsWith("@")) return "symbol";
  return "file";
}

export function getWorktreeCreateName(source: WorktreeLaunchSource): string {
  if (source.kind === "name") {
    return slugFragment(source.title ?? source.label.replace(/^Name:\s*/i, ""));
  }
  if (source.sourceRef?.startsWith("issue:")) {
    return `issue-${source.sourceRef.slice("issue:".length)}`;
  }
  if (source.sourceRef?.startsWith("pr:")) {
    return `pr-${source.sourceRef.slice("pr:".length)}`;
  }
  const ref = source.baseBranch ?? source.title ?? source.label;
  return `${slugFragment(ref.replace(/^Branch:\s*/i, ""))}-worktree`;
}

export function getWorktreeBaseRef(
  source: WorktreeLaunchSource
): string | undefined {
  return source.resolvedBaseRef ?? source.baseBranch;
}
