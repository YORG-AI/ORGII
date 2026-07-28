/**
 * Source Control Hooks
 *
 * Hooks for git source control state management.
 * Used by useSourceControlState in the CodeEditor.
 */

export { useCommitForm } from "./useCommitForm";
export type {
  UseCommitFormOptions,
  UseCommitFormResult,
} from "./useCommitForm";

export { useFileSelection } from "./useFileSelection";
export type {
  UseFileSelectionOptions,
  UseFileSelectionResult,
} from "./useFileSelection";

export { useGitFiles } from "./useGitFiles";
export type { UseGitFilesOptions, UseGitFilesResult } from "./useGitFiles";

export { buildContentFromHunks } from "@src/util/git/buildContentFromHunks";
