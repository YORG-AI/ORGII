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
  const nativeIds = new Set<string>();
  for (const [category, state] of Object.entries(pagination) as Array<
    [SessionListCategory, SessionPaginationMap[SessionListCategory]]
  >) {
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
    const category = sidebarCategoryForSession(session);
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
  options: { registerBeforeInitialPage?: boolean } = {}
): SessionPaginationMap {
  const target = sidebarCategoryForSession(session);
  if (!target || !isNativeCategory(target)) return pagination;

  const alreadyLoaded = BASE_SESSION_LIST_CATEGORIES.some((category) =>
    pagination[category].sessionIds.includes(session.session_id)
  );
  if (
    alreadyLoaded ||
    (pagination[target].generation === 0 && !options.registerBeforeInitialPage)
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

  return {
    ...pagination,
    [target]: {
      ...pagination[target],
      sessionIds: [session.session_id, ...pagination[target].sessionIds],
    },
  };
}
