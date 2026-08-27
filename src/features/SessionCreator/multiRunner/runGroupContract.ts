/**
 * Run group — the record of one fan-out.
 *
 * A group stores only what cannot be recovered from elsewhere: which runner
 * config produced which session, and why a runner produced none. Live status,
 * timing and token counts are NOT stored — those already live on the session
 * records and duplicating them here would create a second source of truth that
 * drifts the moment a session updates.
 */
import type { Runner, RunnerBlocker } from "./contract";

/** What happened when the launcher reached this runner. */
export const RUN_OUTCOME = {
  /** A session exists — its live state is read from the session store. */
  LAUNCHED: "launched",
  /** The launch was attempted and threw (auth, provider, backend). */
  FAILED: "failed",
  /** Pre-flight refused the row; no launch was attempted. */
  SKIPPED: "skipped",
} as const;

export type RunOutcome = (typeof RUN_OUTCOME)[keyof typeof RUN_OUTCOME];

export interface RunGroupEntry {
  /** Ordinal position in the launcher, 1-based — the row's lane identity. */
  ordinal: number;
  outcome: RunOutcome;
  /** Present when `outcome === "launched"`. */
  sessionId?: string;
  /** Present when `outcome === "failed"`. */
  error?: string;
  /** Present when `outcome === "skipped"`. */
  blocker?: RunnerBlocker;
  /**
   * The exact config this entry launched with. Snapshotted rather than
   * referenced so a retry re-runs what the group actually ran, even after the
   * launcher's own runner list has moved on.
   */
  runner: Runner;
}

export interface RunGroup {
  id: string;
  /** The shared prompt, verbatim — the one thing every entry has in common. */
  prompt: string;
  createdAt: string;
  repoPath?: string;
  repoName?: string;
  /** Base branch every runner's worktree was cut from. */
  baseBranch?: string;
  entries: RunGroupEntry[];
}

/** Bounds the persisted registry; oldest groups are evicted first. */
export const RUN_GROUP_MAX_STORED = 50;

const TITLE_MAX_LENGTH = 48;

/**
 * Tab label for a group: the prompt's opening words.
 *
 * A group has no name of its own and asking for one would tax every launch, so
 * the prompt does the work — the same way an untitled session takes its label
 * from its first message.
 */
export function resolveRunGroupTitle(prompt: string): string {
  const collapsed = prompt.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return "Run group";
  if (collapsed.length <= TITLE_MAX_LENGTH) return collapsed;
  const clipped = collapsed.slice(0, TITLE_MAX_LENGTH);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${(lastSpace > TITLE_MAX_LENGTH / 2 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}

/** Session ids of every entry that actually launched, in launcher order. */
export function collectRunGroupSessionIds(group: RunGroup): string[] {
  return group.entries.flatMap((entry) =>
    entry.outcome === RUN_OUTCOME.LAUNCHED && entry.sessionId !== undefined
      ? [entry.sessionId]
      : []
  );
}
