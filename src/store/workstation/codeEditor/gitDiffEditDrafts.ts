/**
 * In-progress edits made in a working-tree diff editor (`GitDiffContent`).
 *
 * The diff editor is unmounted whenever its tab stops being active — the
 * Source Control Focus view and `git-diff` tabs are rebuilt from stores on
 * every visit rather than hidden behind `display:none`. Component-local
 * `editedContent` died with the subtree, so switching to another tab and
 * back silently discarded unsaved edits while the tab bar kept showing the
 * unsaved dot. The draft now lives here, keyed by the absolute file path.
 *
 * Invariant: a draft is only ever restored onto the working-tree content it
 * was written against. `restoreGitDiffEditDraft` compares the stored base with
 * the current content and discards the draft when they differ (the file was
 * saved or changed on disk in between), so a stale draft can never resurrect
 * over newer content. Saving or discarding in the editor deletes the draft;
 * closing a `git-diff` tab deletes its file's draft (close means discard,
 * matching the pre-existing close behaviour).
 */
import { BoundedMap } from "@src/util/collections/BoundedMap";

export interface GitDiffEditDraft {
  /** Working-tree content the edit started from. */
  baseContent: string;
  /** The user's edited buffer. */
  editedContent: string;
}

/** Files with a live draft at once; the LRU tail is dropped beyond this. */
export const MAX_GIT_DIFF_EDIT_DRAFTS = 32;

const drafts = new BoundedMap<string, GitDiffEditDraft>({
  maxSize: MAX_GIT_DIFF_EDIT_DRAFTS,
  name: "gitDiffEditDrafts",
});

/** Record the current edit buffer for `filePath` against `baseContent`. */
export function setGitDiffEditDraft(
  filePath: string,
  baseContent: string,
  editedContent: string
): void {
  if (!filePath) return;
  if (editedContent === baseContent) {
    drafts.delete(filePath);
    return;
  }
  drafts.set(filePath, { baseContent, editedContent });
}

/**
 * Return the draft for `filePath` when it was written against
 * `baseContent`; otherwise drop the stale draft and return `null`.
 */
export function restoreGitDiffEditDraft(
  filePath: string,
  baseContent: string
): string | null {
  const draft = drafts.get(filePath);
  if (!draft) return null;
  if (draft.baseContent !== baseContent) {
    drafts.delete(filePath);
    return null;
  }
  return draft.editedContent;
}

/** Forget the draft for `filePath` (save, discard, tab close). */
export function deleteGitDiffEditDraft(filePath: string): void {
  drafts.delete(filePath);
}

export function hasGitDiffEditDraft(filePath: string): boolean {
  return drafts.has(filePath);
}

export function clearGitDiffEditDrafts(): void {
  drafts.clear();
}
