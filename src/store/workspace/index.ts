/**
 * Workspace Store
 *
 * Multi-root workspace atoms: core folder list, active folder resolution,
 * and display helpers. The folder-list atom itself lives in
 * `src/store/ui/workspaceFoldersAtom.ts` (legacy location) and is re-exported
 * here so consumers can import everything from `@src/store/workspace`.
 */

export {
  // Core storage atoms
  workspaceFoldersAtom,
  workspaceConfigPathAtom,
  activeFolderIdAtom,
  workspaceIsDirtyAtom,
  // DB-backed workspace state
  savedWorkspacesAtom,
  activeWorkspaceIdAtom,
  activeWorkspaceNameAtom,
  workspaceActiveAtom,
  // Derived flags
  isMultiRootWorkspaceAtom,
  hasWorkspaceAtom,
  // Write atoms
  addWorkspaceFolderAtom,
  removeWorkspaceFolderAtom,
  setWorkspaceFoldersAtom,
  setPrimaryFolderAtom,
  reorderFoldersAtom,
  renameFolderAtom,
} from "../ui/workspaceFoldersAtom";

export {
  primaryFolderAtom,
  activeFolderAtom,
  activeWorkspaceFolderRepoAtom,
  activeWorkspaceRootAtom,
  activeWorkspaceRootNameAtom,
  activeWorkspaceRootPathAtom,
  primaryWorkspaceRootAtom,
  primaryWorkspaceRootPathAtom,
  workspaceFolderRepoMapAtom,
  workspaceNameAtom,
  workspaceFolderCountAtom,
  activeWorktreeByRepoAtom,
  activeWorktreeAtom,
  setActiveWorktreeAtom,
  type ActiveWorktreeSelection,
  type WorkspaceRootContext,
} from "./derived";
