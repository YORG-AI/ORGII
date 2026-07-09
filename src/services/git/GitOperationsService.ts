/**
 * GitOperationsService - Unified Git Operations Service (Facade)
 *
 * Provides git operations with full UI parity:
 * - Streaming output to Output panel (when available)
 * - Error dialogs with options: Open Git Log, Show Output, Cancel
 * - Consistent behavior for UI clicks, AI commands, and Spotlight
 * - Fallback to terminal commands when Output integration unavailable
 *
 * This is the SINGLE implementation that all paths should use:
 * - dispatch("git.push") → GitOperationsService.push()
 * - useGitOperations hook → dispatch("git.push")
 * - Source Control button → dispatch("git.push")
 *
 * Implementation is split into focused modules under ./operations/:
 * - commitOps: stage, unstage, discard, commit, amend
 * - branchOps: checkout, stash, stashPop, stashApply, stashDrop
 * - mergeOps:  mergeAbort, rebaseAbort
 * - remoteOps: push, pull, fetch, publish, sync
 *
 * Usage:
 *   import { GitOperationsService } from "@src/services/git";
 *   const result = await GitOperationsService.push({ force: false });
 *
 *   // With error dialog:
 *   const result = await GitOperationsService.pushWithDialog({ force: false });
 */
import * as branchOps from "./operations/branchOps";
import * as commitOps from "./operations/commitOps";
import * as mergeOps from "./operations/mergeOps";
import * as remoteOps from "./operations/remoteOps";
import { getRepoContext, setRepoContext } from "./operations/types";

export type { GitOperationResult } from "./operations/types";

// ============================================
// GitOperationsService - Singleton API
// ============================================

export const GitOperationsService = {
  // --- Context ---
  setRepoContext,
  getRepoContext,

  // --- Remote ops ---
  push: remoteOps.push,
  pull: remoteOps.pull,
  fetch: remoteOps.fetch,
  publish: remoteOps.publish,
  sync: remoteOps.sync,

  // --- Commit ops ---
  stage: commitOps.stage,
  unstage: commitOps.unstage,
  discard: commitOps.discard,
  discardAll: commitOps.discardAll,
  resolveConflict: commitOps.resolveConflict,
  commit: commitOps.commit,
  amend: commitOps.amend,

  // --- Branch ops ---
  /**
   * @internal Raw, unguarded checkout. Do NOT call from UI code.
   * Use `checkoutWithDialog` instead.
   */
  checkoutRaw: branchOps.checkoutRaw,
  stash: branchOps.stash,
  stashPop: branchOps.stashPop,
  stashApply: branchOps.stashApply,
  stashDrop: branchOps.stashDrop,

  // --- Merge / rebase ops ---
  mergeAbort: mergeOps.mergeAbort,
  rebaseAbort: mergeOps.rebaseAbort,

  // --- Dialog variants ---
  pushWithDialog: remoteOps.pushWithDialog,
  pullWithDialog: remoteOps.pullWithDialog,
  fetchWithDialog: remoteOps.fetchWithDialog,
  syncWithDialog: remoteOps.syncWithDialog,
  commitWithDialog: commitOps.commitWithDialog,
  checkoutWithDialog: branchOps.checkoutWithDialog,
  stageWithDialog: commitOps.stageWithDialog,
  unstageWithDialog: commitOps.unstageWithDialog,
};
