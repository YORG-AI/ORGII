/**
 * agentStatusTrailMath
 *
 * Pure helpers behind the end-of-conversation status trail — the live
 * `Agent working for 1h 20m 26s` while a round runs, and the resting
 * `Agent is idle` / `Last refreshed 5 minutes ago` between rounds.
 *
 * Kept free of React and the Jotai graph, like its sibling
 * `streamingHudMath.ts`, so the duration formatting and the activity
 * precedence rules can be unit-tested without a store or a renderer.
 */

/**
 * What the trail row shows. The three visible phases are the same three
 * states the sidebar's session dot has — see `resolveTrailPhase`.
 *
 * - `"hidden"` — no row at all: no session, or a surface that must not carry
 *   a live readout (a paginated page that is not the final round).
 * - `"idle"` — the agent mark at rest with a short label. The transcript
 *   always ends with the agent's own glyph, so the panel reads as "here, and
 *   waiting" rather than simply stopping.
 * - `"asking"` — the round is parked on a question for the viewer.
 * - `"running"` — the full readout, mark pulsing.
 */
export type AgentStatusTrailPhase = "hidden" | "idle" | "asking" | "running";

/**
 * No transcript activity for this long and the trail stops calling a session
 * "running", whatever its status says.
 *
 * A status can outlive the work it describes: nothing writes a terminal
 * status for an imported Claude Code / Codex transcript when that process
 * exits, and the native runtime atom can be left on `running` by a dropped
 * `agent:complete` — the case `usePlanningIndicator`'s watchdog exists for.
 * Either way the trail would sit there pulsing "Running tools... 3h 20m"
 * forever, which is the most confidently wrong thing it could say.
 *
 * Shorter than `TAIL_TURN_STALE_MS` (10 min) on purpose: that window folds a
 * turn's content away, so it is deliberately conservative. This one only
 * changes a label and a pulse, so it can afford to be honest sooner.
 */
export const TRAIL_IDLE_AFTER_MS = 5 * 60_000;

/**
 * Milliseconds until the trail should stop reading as running, floored at 0.
 *
 * Same shape as `resolveTailTurnStaleDelayMs`: callers arm ONE timer for the
 * remainder of the window rather than polling, and re-arm whenever activity
 * moves. Clamping at zero keeps a session reopened long after its last event
 * on the timer path instead of turning into a synchronous state write from an
 * effect body (a cascading render).
 */
export function resolveTrailStaleDelayMs(
  lastActivityAtMs: number,
  nowMs: number
): number {
  return Math.max(lastActivityAtMs + TRAIL_IDLE_AFTER_MS - nowMs, 0);
}

interface ResolveTrailPhaseOptions {
  /** False on a surface that must not carry the trail at all. */
  enabled: boolean;
  hasSession: boolean;
  /** `isSessionInProgress(session.status)`, or a scoped surface's liveness. */
  inProgress: boolean;
  /** `isSessionPendingAsking(session)` — status is `waiting_for_user`. */
  pendingAsking: boolean;
  /**
   * No transcript activity for `TRAIL_IDLE_AFTER_MS`. Overrides `inProgress`;
   * see the constant. Never true when the last activity is unknown — an
   * absent timestamp is not evidence of silence.
   */
  stale: boolean;
}

/**
 * The trail's phase, in the SAME precedence the sidebar row uses for its
 * status dot (`menuItemBuilders.buildSessionMenuItem`):
 *
 *     inProgress && !pendingAsking  ->  breathing marker   (here: "running")
 *     pendingAsking                 ->  "asking" dot tone  (here: "asking")
 *     otherwise                     ->  resting dot        (here: "idle")
 *
 * with one addition the sidebar does not need: `stale` demotes a "running"
 * session to resting. A row in a list can afford to trust a status that has
 * gone quiet; a line that renders a live elapsed counter cannot, because it
 * would keep counting up next to work that stopped. `pendingAsking` still
 * wins over it — a question that has been open for an hour is still open.
 *
 * `waiting_for_user` is itself one of `IN_PROGRESS_STATUSES`, so the asking
 * check MUST come first or a session parked on a question would read as
 * actively working — the same trap the sidebar's `&& !pendingAsking` guard
 * exists to avoid. Keeping the order here, in one pure function, is what
 * stops the trail and the sidebar from ever describing a session two
 * different ways.
 *
 * The sidebar's fourth tone, `unread`, has no meaning here: it marks a
 * finished session the viewer has not opened, and the trail only ever renders
 * inside the session being viewed.
 */
export function resolveTrailPhase({
  enabled,
  hasSession,
  inProgress,
  pendingAsking,
  stale,
}: ResolveTrailPhaseOptions): AgentStatusTrailPhase {
  if (!enabled || !hasSession) return "hidden";
  if (pendingAsking) return "asking";
  if (inProgress && !stale) return "running";
  return "idle";
}

export interface AgentStatusTrailState {
  phase: AgentStatusTrailPhase;
  /**
   * Epoch ms the running round started, or `null` when it is unknown (an
   * empty transcript, or a page that does not hold the tail turn) — the
   * trail then drops the duration segment rather than showing 0.
   *
   * Deliberately the ANCHOR, not the elapsed span: this object is handed
   * down through `ChatHistoryList`, whose `memo` would be busted once a
   * second by a value that ticks. The component owns the clock instead, so
   * only the trail row itself re-renders per second.
   */
  startedAtMs: number | null;
  /**
   * Background shell processes plus running subagent workers. Surfaced only
   * in the RESTING phases, where "Agent is idle" alongside two live shells
   * would be false. A running round already says work is happening, so
   * repeating the count there would only crowd the line.
   */
  runningTasks: number;
  /**
   * True for a transcript ORGII mirrors rather than runs — an imported
   * Claude Code / Codex / Cursor session. It changes what the resting phase
   * can honestly say; see `resolveTrailRestLabel`.
   */
  isExternal: boolean;
  /**
   * Epoch ms of the last importer scan of this session's data source
   * (`DataSourceConfig.lastScannedAt`), or `null` when this install has not
   * recorded one. Meaningful only for external sessions.
   */
  lastRefreshedAtMs: number | null;
}

export const HIDDEN_AGENT_STATUS_TRAIL_STATE: AgentStatusTrailState = {
  phase: "hidden",
  startedAtMs: null,
  runningTasks: 0,
  isExternal: false,
  lastRefreshedAtMs: null,
};

/**
 * What the resting (non-running) phases can truthfully say.
 *
 * - `"agentIdle"` — ORGII runs this agent, so "the agent is idle" is a claim
 *   it is entitled to make.
 * - `"lastRefreshed"` — an imported transcript. ORGII does not run that agent
 *   and cannot know whether it is idle: the process may be mid-turn in
 *   someone's terminal right now. What ORGII does know is when it last
 *   scanned the source, so that is what it reports.
 * - `"none"` — external, with no scan on record. Neither statement is
 *   available, so the row falls back to the bare mark rather than inventing
 *   one.
 */
export type AgentStatusTrailRestLabel = "agentIdle" | "lastRefreshed" | "none";

export function resolveTrailRestLabel(options: {
  isExternal: boolean;
  lastRefreshedAtMs: number | null;
}): AgentStatusTrailRestLabel {
  if (!options.isExternal) return "agentIdle";
  return options.lastRefreshedAtMs === null ? "none" : "lastRefreshed";
}

/**
 * `26s` / `20m 26s` / `1h 20m 26s`.
 *
 * Every unit above the smallest stays visible once it is nonzero, so the
 * string only ever grows while a round runs — it never re-shortens mid-run
 * the way a "largest unit only" format would when minutes roll over.
 */
export function formatTrailElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (totalMinutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Elapsed time for the running round, or `null` when it cannot be trusted.
 *
 * A start in the future (clock skew between the event's `createdAt` and this
 * machine, or a session restored across a time change) would render as a
 * negative duration, so it is reported as unknown instead.
 */
export function resolveTrailElapsedMs(
  startedAtMs: number | null,
  nowMs: number
): number | null {
  if (startedAtMs === null || !Number.isFinite(startedAtMs)) return null;
  const elapsed = nowMs - startedAtMs;
  return elapsed >= 0 ? elapsed : null;
}
