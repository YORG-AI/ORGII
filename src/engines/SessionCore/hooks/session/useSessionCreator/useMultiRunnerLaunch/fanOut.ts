/**
 * Fan-out orchestration — one prompt, N runners, N sessions.
 *
 * Kept free of React and Tauri so the part that actually matters (what happens
 * when runner 2 of 3 throws) is unit-testable with a fake launcher.
 *
 * Two invariants this encodes:
 *  - **Failure is per-runner.** A blocked or throwing runner produces its own
 *    entry and the loop continues; the whole point of a comparison is that one
 *    missing CLI does not cost you the other two runs.
 *  - **Launcher order is preserved.** Entries come back in list order with
 *    1-based ordinals, so the group surface can line rows up with the launcher
 *    the user configured, including the rows that never launched.
 */
import type {
  Runner,
  RunnerBlocker,
} from "@src/features/SessionCreator/multiRunner/contract";
import {
  RUN_OUTCOME,
  type RunGroupEntry,
} from "@src/features/SessionCreator/multiRunner/runGroupContract";
import { type WorktreeLaunchSelection } from "@src/store/session/worktreeLaunchSourceAtom";

export interface FanOutOptions {
  /** The launcher's full list, in display order — ordinals come from here. */
  runners: readonly Runner[];
  /** Pre-flight verdict per runner; `null` means "may launch". */
  resolveBlocker: (runner: Runner) => RunnerBlocker | null;
  /** Launch one runner; resolves to its new session id. */
  launchRunner: (runner: Runner) => Promise<string>;
  /** Awaited before every launch except the first. */
  stagger: () => Promise<void>;
  /** Called for each thrown launch so the caller can log it. */
  onLaunchError?: (runner: Runner, error: unknown) => void;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function fanOutRunners({
  runners,
  resolveBlocker,
  launchRunner,
  stagger,
  onLaunchError,
}: FanOutOptions): Promise<RunGroupEntry[]> {
  const entries: RunGroupEntry[] = [];
  let attempted = 0;

  for (const [index, runner] of runners.entries()) {
    const ordinal = index + 1;
    const blocker = resolveBlocker(runner);

    if (blocker !== null) {
      entries.push({
        ordinal,
        outcome: RUN_OUTCOME.SKIPPED,
        blocker,
        runner,
      });
      continue;
    }

    if (attempted > 0) await stagger();
    attempted += 1;

    try {
      const sessionId = await launchRunner(runner);
      entries.push({
        ordinal,
        outcome: RUN_OUTCOME.LAUNCHED,
        sessionId,
        runner,
      });
    } catch (error) {
      onLaunchError?.(runner, error);
      entries.push({
        ordinal,
        outcome: RUN_OUTCOME.FAILED,
        error: describeError(error),
        runner,
      });
    }
  }

  return entries;
}

/**
 * Strip an existing-worktree pick out of the launch selection.
 *
 * Reusing one registered checkout would hand every runner the same working
 * tree — the exact corruption worktree-per-runner exists to prevent. The base
 * ref survives so the isolated worktrees are still cut from the branch or PR
 * head the user chose.
 */
export function sanitizeWorktreeSelectionForFanOut(
  selection: WorktreeLaunchSelection | null
): WorktreeLaunchSelection | null {
  if (!selection) return null;
  if (!selection.source.existingWorktreePath) return selection;
  const { existingWorktreePath: _dropped, ...source } = selection.source;
  return { ...selection, source };
}
