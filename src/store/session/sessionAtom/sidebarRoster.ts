import { RUST_AGENT_TYPE } from "@src/api/tauri/agent/types";
import {
  getImportedHistorySourceBySessionId,
  isImportedHistoryListCategory,
} from "@src/api/tauri/externalHistory";
import { getRustAgentType } from "@src/util/session/sessionDispatch";

import {
  BASE_SESSION_LIST_CATEGORIES,
  type BaseSessionListCategory,
  type SessionListCategory,
  type SessionPaginationMap,
} from "./paginationAtoms";
import type { Session } from "./types";

/**
 * Resolve the single backend roster stream that owns a top-level session.
 * Imported history is checked first because it deliberately does not
 * participate in native pin persistence.
 */
export function sidebarCategoryForSession(
  session: Session
): SessionListCategory | null {
  const importedSource = getImportedHistorySourceBySessionId(
    session.session_id
  );
  if (importedSource) return importedSource.listCategory;
  if (session.pinned) return "pinned_native";
  if (session.agentOrgId) return "agent_org_root";
  if (session.category === "cli_agent") return "cli_agent";
  if (session.category === "human_session") return "human_session";
  if (getRustAgentType(session.session_id) === RUST_AGENT_TYPE.OS) {
    return "os_agent";
  }
  if (session.category === "rust_agent" || session.category === undefined) {
    return "standalone_agent";
  }
  return null;
}

/**
 * Build a cheap matcher once per render. Generation zero means the stream has
 * not received its authoritative first page yet, so cached rows remain
 * provisional and visible until that page replaces the window.
 */
export function createSidebarRosterMatcher(
  pagination: SessionPaginationMap
): (session: Session) => boolean {
  const idsByCategory = new Map<SessionListCategory, ReadonlySet<string>>();
  const localCategoryById = new Map<string, BaseSessionListCategory>();
  const nativeIds = new Set<string>();
  for (const [category, state] of Object.entries(pagination) as Array<
    [SessionListCategory, SessionPaginationMap[SessionListCategory]]
  >) {
    if (isNativeCategory(category)) {
      for (const sessionId of state.localSessionIds) {
        nativeIds.add(sessionId);
        localCategoryById.set(sessionId, category);
      }
    }
    if (state.generation > 0) {
      idsByCategory.set(category, new Set(state.sessionIds));
      if (isNativeCategory(category)) {
        for (const sessionId of state.sessionIds) {
          nativeIds.add(sessionId);
        }
      }
    }
  }
  return (session: Session): boolean => {
    const category =
      localCategoryById.get(session.session_id) ??
      sidebarCategoryForSession(session);
    if (!category) return false;
    const authoritativeIds = idsByCategory.get(category);
    if (!authoritativeIds) {
      return pagination[category].generation === 0;
    }
    // Pin/unpin changes the entity's category immediately, but it must not
    // rewrite either stream's authoritative page or cursor. A native row that
    // was loaded by any native stream therefore remains visible while its new
    // owner eventually encounters it through normal keyset pagination.
    return isNativeCategory(category)
      ? nativeIds.has(session.session_id)
      : authoritativeIds.has(session.session_id);
  };
}

/**
 * Register a backend-confirmed local creation without mutating the server
 * page/cursor. The overlay survives an older in-flight roster response and is
 * removed only after a native roster read returns the same ID.
 */
export function registerCreatedSessionWithRoster(
  pagination: SessionPaginationMap,
  session: Session,
  explicitTarget?: BaseSessionListCategory
): SessionPaginationMap {
  const target = explicitTarget ?? sidebarCategoryForSession(session);
  if (!target || !isNativeCategory(target)) return pagination;

  const alreadyKnown = BASE_SESSION_LIST_CATEGORIES.some((category) => {
    const state = pagination[category];
    return (
      state.sessionIds.includes(session.session_id) ||
      state.localSessionIds.includes(session.session_id)
    );
  });
  if (alreadyKnown) return pagination;

  return {
    ...pagination,
    [target]: {
      ...pagination[target],
      localSessionIds: [
        session.session_id,
        ...pagination[target].localSessionIds,
      ],
    },
  };
}

/** Remove locally registered IDs once a native roster response confirms them. */
export function acknowledgeCreatedSessionsInNativeRoster(
  pagination: SessionPaginationMap,
  sessions: readonly Session[]
): SessionPaginationMap {
  const confirmedIds = new Set(sessions.map((session) => session.session_id));
  if (confirmedIds.size === 0) return pagination;

  let next = pagination;
  for (const category of BASE_SESSION_LIST_CATEGORIES) {
    const state = next[category];
    const localSessionIds = state.localSessionIds.filter(
      (sessionId) => !confirmedIds.has(sessionId)
    );
    if (localSessionIds.length === state.localSessionIds.length) continue;
    if (next === pagination) next = { ...pagination };
    next = {
      ...next,
      [category]: { ...state, localSessionIds },
    };
  }
  return next;
}

/** Evict a deleted session from both server-page and local overlay rosters. */
export function removeSessionFromRosters(
  pagination: SessionPaginationMap,
  sessionId: string
): SessionPaginationMap {
  let next = pagination;
  for (const category of Object.keys(pagination) as SessionListCategory[]) {
    const state = next[category];
    const sessionIds = state.sessionIds.filter((id) => id !== sessionId);
    const localSessionIds = state.localSessionIds.filter(
      (id) => id !== sessionId
    );
    if (
      sessionIds.length === state.sessionIds.length &&
      localSessionIds.length === state.localSessionIds.length
    ) {
      continue;
    }
    if (next === pagination) next = { ...pagination };
    next = {
      ...next,
      [category]: { ...state, sessionIds, localSessionIds },
    };
  }
  return next;
}

function isNativeCategory(
  category: SessionListCategory
): category is BaseSessionListCategory {
  return (
    !isImportedHistoryListCategory(category) &&
    BASE_SESSION_LIST_CATEGORIES.includes(category as BaseSessionListCategory)
  );
}

/**
 * Keep a newly discovered native row visible without rewriting pagination
 * ownership for rows already loaded by another native stream. Pin/unpin is
 * rendered from the session entity itself; retaining the original roster ID
 * lets the destination stream encounter the row normally without a
 * duplicate-only page.
 */
export function syncSessionWithNativeRosters(
  pagination: SessionPaginationMap,
  session: Session,
  options: { promoteLocalCreation?: boolean } = {}
): SessionPaginationMap {
  const target = sidebarCategoryForSession(session);
  if (!target || !isNativeCategory(target)) return pagination;

  const loadedByServer = BASE_SESSION_LIST_CATEGORIES.some((category) =>
    pagination[category].sessionIds.includes(session.session_id)
  );
  const locallyRegistered = BASE_SESSION_LIST_CATEGORIES.some((category) => {
    const state = pagination[category];
    return state.localSessionIds.includes(session.session_id);
  });
  if (loadedByServer) {
    return locallyRegistered && options.promoteLocalCreation
      ? acknowledgeCreatedSessionsInNativeRoster(pagination, [session])
      : pagination;
  }
  if (
    (locallyRegistered && !options.promoteLocalCreation) ||
    pagination[target].generation === 0
  ) {
    return pagination;
  }

  const cursor = pagination[target].cursor;
  if (cursor) {
    const updatedAtComparison = (session.updated_at ?? "").localeCompare(
      cursor.updatedAt
    );
    const sortsAheadOfCursor =
      updatedAtComparison > 0 ||
      (updatedAtComparison === 0 &&
        session.session_id.localeCompare(cursor.sessionId) > 0);
    // The bounded safety refresh can see older uncached history. Only rows
    // ahead of the authoritative window are genuinely new sidebar arrivals;
    // rows at or behind its tail still belong behind Load more.
    if (!sortsAheadOfCursor) {
      return pagination;
    }
  }

  const synced = {
    ...pagination,
    [target]: {
      ...pagination[target],
      sessionIds: [session.session_id, ...pagination[target].sessionIds],
    },
  };
  return locallyRegistered
    ? acknowledgeCreatedSessionsInNativeRoster(synced, [session])
    : synced;
}
