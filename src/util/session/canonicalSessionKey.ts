/**
 * Canonical session identity for collapsing dual-ingested sessions.
 *
 * A few external tools reach ORGII through TWO ingestion pipelines that each
 * mint their own session id for the *same* underlying transcript:
 *
 *   - the native CLI scanner (`cli_session_cache`), e.g. `codex:<rollout-stem>`
 *   - the imported-history cache (`imported_history_session_cache`),
 *     e.g. `codexapp-<rollout-stem>`
 *
 * Both derive their id from the same rollout file stem, so the two rows are the
 * same session shown twice. `canonicalSessionKey` maps the known twin prefixes
 * to a shared `family::stem` key; every other id passes through unchanged
 * (keyed by itself) so unrelated sessions can never be merged by accident.
 *
 * Verified twin: Codex — CLI `codex:<stem>` vs imported `codexapp-<stem>`, where
 * `<stem>` is the `path.file_stem()` of the dated Codex rollout JSONL file
 * (under `~/.codex/sessions/`) in both pipelines.
 */

interface TwinPrefix {
  /** The id prefix minted by one pipeline. */
  prefix: string;
  /** Shared family label; twins in the same family collapse together. */
  family: string;
}

/**
 * Order does not matter for correctness (prefixes within a family are disjoint),
 * but keep the most specific prefixes first to avoid a shorter prefix shadowing
 * a longer one if families are ever extended.
 */
const TWIN_PREFIXES: readonly TwinPrefix[] = [
  { prefix: "codexapp-", family: "codex" },
  { prefix: "codex:", family: "codex" },
];

/**
 * Returns the identity key two dual-ingested rows of the same session share.
 * For non-twinned ids this is just the id itself.
 */
export function canonicalSessionKey(sessionId: string): string {
  for (const { prefix, family } of TWIN_PREFIXES) {
    if (sessionId.startsWith(prefix)) {
      return `${family}::${sessionId.slice(prefix.length)}`;
    }
  }
  return sessionId;
}

/**
 * True when `sessionId` is one of the known dual-ingested twin ids. Useful for
 * tests and diagnostics; not required by {@link dedupeByCanonicalSession}.
 */
export function isTwinnedSessionId(sessionId: string): boolean {
  return TWIN_PREFIXES.some(({ prefix }) => sessionId.startsWith(prefix));
}

interface DedupableSession {
  session_id: string;
  filesChanged?: number;
  touchedFiles?: string[];
  totalTokens?: number;
  model?: string;
  category?: string;
  updated_at?: string;
}

/**
 * Higher score = richer card. When two ids share a canonical key we keep the
 * higher-scoring one so the surviving card carries impact / tokens / model
 * rather than the bare CLI-cache stub. Ties fall back to the imported
 * (read-only external-history) copy, then to the most recently updated.
 */
function richnessScore(session: DedupableSession): number {
  const hasImpact =
    (session.filesChanged ?? 0) > 0 || (session.touchedFiles?.length ?? 0) > 0;
  const hasTokens = (session.totalTokens ?? 0) > 0;
  const hasModel = Boolean(session.model);
  const isImported = session.category === "external_history";
  return (
    (hasImpact ? 8 : 0) +
    (hasTokens ? 4 : 0) +
    (hasModel ? 2 : 0) +
    (isImported ? 1 : 0)
  );
}

function prefersRight(
  incumbent: DedupableSession,
  candidate: DedupableSession
): boolean {
  const incumbentScore = richnessScore(incumbent);
  const candidateScore = richnessScore(candidate);
  if (candidateScore !== incumbentScore) {
    return candidateScore > incumbentScore;
  }
  // Equal richness: prefer the more recently updated row for stability.
  return (candidate.updated_at ?? "") > (incumbent.updated_at ?? "");
}

/**
 * Collapse dual-ingested duplicates, keeping the richer copy per canonical key.
 * Input order is otherwise preserved (the surviving row keeps the position of
 * whichever copy was seen first).
 */
export function dedupeByCanonicalSession<T extends DedupableSession>(
  sessions: readonly T[]
): T[] {
  const indexByKey = new Map<string, number>();
  const result: T[] = [];
  for (const session of sessions) {
    const key = canonicalSessionKey(session.session_id);
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, result.length);
      result.push(session);
      continue;
    }
    if (prefersRight(result[existingIndex], session)) {
      result[existingIndex] = session;
    }
  }
  return result;
}
