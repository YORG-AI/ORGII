/**
 * Session list persistence.
 *
 * Hydrates the in-memory `sessionsAtom` from `localStorage` at app start so the
 * sidebar can render the previous list immediately on cold launch — no
 * spinner, no empty flash. The persisted data is **only** the small `Session`
 * metadata shape (id / name / status / timestamps / category / model / icon
 * id, etc.). We never persist chat content, tool calls, prompts, or anything
 * read out of Cursor's `state.vscdb` — those are fetched on demand.
 *
 * Persistence is bounded:
 * - At most `MAX_PERSISTED_ROWS` rows, sorted by `updated_at` desc, are saved.
 * - A schema version (`v1`) is embedded so future `Session` shape changes can
 *   invalidate cached data with a single bump.
 * - Writes are debounced (the call site does the debouncing — `loadSessions()`
 *   only writes after a successful fetch, so writes are naturally rate-limited
 *   to refresh frequency).
 *
 * Failure modes are silent: a corrupt cache yields `[]` and a fresh fetch.
 */
import { syncClientCreatedSessionRecords } from "./createdSessionRegistry";
import type { Session } from "./types";

const STORAGE_KEY = "orgii:sessionsAtom:v1";

// Cap so a power user with thousands of sessions can't push us past the
// ~5MB localStorage quota. 200 rows × ~1KB JSON ≈ 200KB worst case, well
// under quota.
const MAX_PERSISTED_ROWS = 200;

interface PersistedShape {
  version: 1;
  ts: number;
  sessions: Session[];
}

function stripVolatileSessionFields(session: Session): Session {
  const {
    draftText: _draftText,
    replyTargetEventId: _replyTargetEventId,
    ...persistedSession
  } = session;
  return persistedSession;
}

export function loadPersistedSessions(): Session[] {
  if (typeof localStorage === "undefined") return [];

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<PersistedShape> | null;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.version !== 1 ||
      !Array.isArray(parsed.sessions)
    ) {
      return [];
    }
    return parsed.sessions.map(stripVolatileSessionFields);
  } catch {
    return [];
  }
}

export function persistSessions(sessions: Session[]): void {
  if (typeof localStorage === "undefined") return;

  syncClientCreatedSessionRecords(sessions);

  // Sort + truncate before serializing so the persisted slice is the most
  // recently active rows. We don't mutate the caller's array.
  const trimmed = sessions
    .slice()
    .sort((sessionA, sessionB) =>
      (sessionB.updated_at || "").localeCompare(sessionA.updated_at || "")
    )
    .slice(0, MAX_PERSISTED_ROWS)
    .map(stripVolatileSessionFields);

  const payload: PersistedShape = {
    version: 1,
    ts: Date.now(),
    sessions: trimmed,
  };

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Quota exceeded or serialization error — nothing useful we can do; the
    // in-memory atom is still authoritative for this session.
  }
}

export const __PERSISTENCE_INTERNALS = {
  STORAGE_KEY,
  MAX_PERSISTED_ROWS,
};
