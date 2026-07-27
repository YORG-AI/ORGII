import { describe, expect, it, vi } from "vitest";

import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import {
  SESSION_LIST_CATEGORIES,
  type Session,
  type SessionListCategory,
  type SessionPaginationMap,
  sessionPaginationScopeKey,
} from "@src/store/session";

import {
  UNIFIED_LOAD_MORE_ID,
  appendSessionGroup,
  getLoadMoreScopeKey,
  getUnifiedLoadMoreState,
  isUnifiedLoadMoreId,
  loadUnifiedReadyCategories,
  scopedLoadMoreRow,
  unifiedLoadMoreRow,
} from "../paginationHelpers";

function makeSession(sessionId: string): Session {
  return {
    session_id: sessionId,
    status: "completed",
    created_at: "2026-06-09T00:00:00.000Z",
    updated_at: "2026-06-09T00:00:00.000Z",
  };
}

function buildSessionRow(session: Session): NavigationMenuItem {
  return {
    id: session.session_id,
    key: session.session_id,
    label: session.session_id,
  };
}

function makePagination(
  overrides: Partial<SessionPaginationMap> = {}
): SessionPaginationMap {
  return Object.fromEntries(
    SESSION_LIST_CATEGORIES.map((category) => [
      category,
      overrides[category] ?? {
        loaded: 0,
        hasMore: false,
        loading: false,
      },
    ])
  ) as SessionPaginationMap;
}

describe("appendSessionGroup", () => {
  it("returns false when all sessions are visible", () => {
    const items: NavigationMenuItem[] = [];
    const hasHiddenLocalSessions = appendSessionGroup({
      items,
      groupId: "time:today",
      groupSessions: [makeSession("osagent-1"), makeSession("osagent-2")],
      visibleCount: 2,
      buildSessionRow,
      loadMoreLabel: "Load more",
    });

    expect(hasHiddenLocalSessions).toBe(false);
    expect(items.map((item) => item.id)).toEqual(["osagent-1", "osagent-2"]);
  });

  it("returns true and appends one local load-more row when sessions are hidden", () => {
    const items: NavigationMenuItem[] = [];
    const hasHiddenLocalSessions = appendSessionGroup({
      items,
      groupId: "time:today",
      groupSessions: [makeSession("osagent-1"), makeSession("osagent-2")],
      visibleCount: 1,
      buildSessionRow,
      loadMoreLabel: "Load more",
    });

    expect(hasHiddenLocalSessions).toBe(true);
    expect(items.map((item) => item.id)).toEqual([
      "osagent-1",
      "load-more-group-time:today",
    ]);
  });
});

describe("unified backend load-more helpers", () => {
  it("keeps the legacy category DOM id while routing through the scoped cursor", () => {
    const scope = {
      kind: "category" as const,
      category: "rust_agent:sde" as const,
      orgIds: ["personal-org"],
    };
    const row = scopedLoadMoreRow(
      scope,
      { visible: true, loading: false, disabled: false },
      "Load more"
    );

    expect(row.dataMenuItemId).toBe("load-more-rust_agent:sde");
    expect(getLoadMoreScopeKey(row.id)).toBe(sessionPaginationScopeKey(scope));
    expect(row.dataTestId).toContain(
      encodeURIComponent(sessionPaginationScopeKey(scope))
    );
  });

  it("returns all ready categories while exposing one visible unified state", () => {
    const firstCategory = SESSION_LIST_CATEGORIES[0] as SessionListCategory;
    const secondCategory = SESSION_LIST_CATEGORIES[1] as SessionListCategory;
    const state = getUnifiedLoadMoreState(
      makePagination({
        [firstCategory]: { loaded: 10, hasMore: true, loading: false },
        [secondCategory]: { loaded: 10, hasMore: true, loading: false },
      })
    );

    expect(state).toEqual({
      visible: true,
      loading: false,
      disabled: false,
      readyCategories: [firstCategory, secondCategory],
    });
  });

  it("excludes loading categories from ready categories and marks unified state loading", () => {
    const loadingCategory = SESSION_LIST_CATEGORIES[0] as SessionListCategory;
    const readyCategory = SESSION_LIST_CATEGORIES[1] as SessionListCategory;
    const state = getUnifiedLoadMoreState(
      makePagination({
        [loadingCategory]: { loaded: 10, hasMore: true, loading: true },
        [readyCategory]: { loaded: 10, hasMore: true, loading: false },
      })
    );

    expect(state.visible).toBe(true);
    expect(state.loading).toBe(true);
    expect(state.disabled).toBe(false);
    expect(state.readyCategories).toEqual([readyCategory]);
  });

  it("keeps the unified row enabled while loading when categories are ready", () => {
    const readyCategory = SESSION_LIST_CATEGORIES[0] as SessionListCategory;
    const state = getUnifiedLoadMoreState(
      makePagination({
        [readyCategory]: { loaded: 10, hasMore: true, loading: false },
        [SESSION_LIST_CATEGORIES[1] as SessionListCategory]: {
          loaded: 10,
          hasMore: true,
          loading: true,
        },
      })
    );
    const row = unifiedLoadMoreRow(state, "Loading");

    expect(row.id).toBe(UNIFIED_LOAD_MORE_ID);
    expect(row.key).toBe(UNIFIED_LOAD_MORE_ID);
    expect(row.label).toBe("Loading");
    expect(row.disabled).toBe(false);
    expect(row.trailingElement).toBeDefined();
  });

  it("disables the unified row when every remaining category is already loading", () => {
    const loadingCategory = SESSION_LIST_CATEGORIES[0] as SessionListCategory;
    const state = getUnifiedLoadMoreState(
      makePagination({
        [loadingCategory]: { loaded: 10, hasMore: true, loading: true },
      })
    );
    const row = unifiedLoadMoreRow(state, "Loading");

    expect(state.disabled).toBe(true);
    expect(row.disabled).toBe(true);
  });

  it("only matches the unified backend load-more id", () => {
    expect(isUnifiedLoadMoreId(UNIFIED_LOAD_MORE_ID)).toBe(true);
    expect(isUnifiedLoadMoreId("load-more-cursor_ide")).toBe(false);
  });

  it("loads every ready category and skips loading categories", async () => {
    const loadingCategory = SESSION_LIST_CATEGORIES[0] as SessionListCategory;
    const firstReadyCategory =
      SESSION_LIST_CATEGORIES[1] as SessionListCategory;
    const secondReadyCategory =
      SESSION_LIST_CATEGORIES[2] as SessionListCategory;
    const loadCategory = vi.fn(() => Promise.resolve());

    const result = loadUnifiedReadyCategories({
      pagination: makePagination({
        [loadingCategory]: { loaded: 10, hasMore: true, loading: true },
        [firstReadyCategory]: { loaded: 10, hasMore: true, loading: false },
        [secondReadyCategory]: { loaded: 10, hasMore: true, loading: false },
      }),
      loadCategory,
    });

    expect(result).toBeInstanceOf(Promise);
    await result;
    expect(loadCategory).toHaveBeenCalledTimes(2);
    expect(loadCategory).toHaveBeenNthCalledWith(1, firstReadyCategory);
    expect(loadCategory).toHaveBeenNthCalledWith(2, secondReadyCategory);
  });

  it("does not load categories when the unified row is disabled", () => {
    const readyCategory = SESSION_LIST_CATEGORIES[0] as SessionListCategory;
    const loadCategory = vi.fn(() => Promise.resolve());

    const result = loadUnifiedReadyCategories({
      disabled: true,
      pagination: makePagination({
        [readyCategory]: { loaded: 10, hasMore: true, loading: false },
      }),
      loadCategory,
    });

    expect(result).toBeNull();
    expect(loadCategory).not.toHaveBeenCalled();
  });
});
