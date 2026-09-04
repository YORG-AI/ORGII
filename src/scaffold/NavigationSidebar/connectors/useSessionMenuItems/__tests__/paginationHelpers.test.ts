import { describe, expect, it, vi } from "vitest";

import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import {
  type CategoryPaginationState,
  SESSION_LIST_CATEGORIES,
  type Session,
  type SessionListCategory,
  type SessionPaginationMap,
} from "@src/store/session";

import {
  UNIFIED_LOAD_MORE_ID,
  appendSessionGroup,
  executeSessionPaginationPlan,
  getUnifiedPaginationPlan,
  hasSessionPaginationPlan,
  isUnifiedLoadMoreId,
  shouldRenderBackendPagination,
  unifiedLoadMoreRow,
} from "../paginationHelpers";

function streamState(
  phase: CategoryPaginationState["phase"]
): CategoryPaginationState {
  return {
    sessionIds: [],
    cursor: null,
    phase,
    generation: 1,
  };
}

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
      overrides[category] ?? streamState("exhausted"),
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
  it("hides ready pagination when the current sidebar scope has no session rows", () => {
    const readyCategory = SESSION_LIST_CATEGORIES[0] as SessionListCategory;
    const pagination = makePagination({
      [readyCategory]: streamState("ready"),
    });

    expect(
      shouldRenderBackendPagination(pagination[readyCategory], false)
    ).toBe(false);
    expect(getUnifiedPaginationPlan(pagination, false)).toBeNull();
  });

  it("keeps an empty scope retryable when its backend stream failed", () => {
    const failedCategory = SESSION_LIST_CATEGORIES[0] as SessionListCategory;
    const pagination = makePagination({
      [failedCategory]: streamState("error"),
    });

    expect(
      shouldRenderBackendPagination(pagination[failedCategory], false)
    ).toBe(true);
    const plan = getUnifiedPaginationPlan(pagination, false);
    expect(plan).toEqual({
      targets: [{ category: failedCategory, phase: "error" }],
    });
    const row = unifiedLoadMoreRow(plan!, "Retry");
    expect(hasSessionPaginationPlan(row)).toBe(true);
    expect(row.sessionPaginationPlan).toBe(plan);
  });

  it("returns all ready categories while exposing one visible unified state", () => {
    const firstCategory = SESSION_LIST_CATEGORIES[0] as SessionListCategory;
    const secondCategory = SESSION_LIST_CATEGORIES[1] as SessionListCategory;
    const plan = getUnifiedPaginationPlan(
      makePagination({
        [firstCategory]: streamState("ready"),
        [secondCategory]: streamState("ready"),
      }),
      true
    );

    expect(plan).toEqual({
      targets: [
        { category: firstCategory, phase: "ready" },
        { category: secondCategory, phase: "ready" },
      ],
    });
  });

  it("excludes loading categories from ready categories and marks unified state loading", () => {
    const loadingCategory = SESSION_LIST_CATEGORIES[0] as SessionListCategory;
    const readyCategory = SESSION_LIST_CATEGORIES[1] as SessionListCategory;
    const plan = getUnifiedPaginationPlan(
      makePagination({
        [loadingCategory]: streamState("loading"),
        [readyCategory]: streamState("ready"),
      }),
      true
    );

    expect(plan).toEqual({
      targets: [
        { category: loadingCategory, phase: "loading" },
        { category: readyCategory, phase: "ready" },
      ],
    });
  });

  it("disables the unified row while any category is loading", () => {
    const readyCategory = SESSION_LIST_CATEGORIES[0] as SessionListCategory;
    const plan = getUnifiedPaginationPlan(
      makePagination({
        [readyCategory]: streamState("ready"),
        [SESSION_LIST_CATEGORIES[1] as SessionListCategory]: {
          ...streamState("loading"),
        },
      }),
      true
    );
    const row = unifiedLoadMoreRow(plan!, "Loading");

    expect(row.id).toBe(UNIFIED_LOAD_MORE_ID);
    expect(row.key).toBe(UNIFIED_LOAD_MORE_ID);
    expect(row.label).toBe("Loading");
    expect(row.disabled).toBe(true);
    expect(row.trailingElement).toBeDefined();
  });

  it("disables the unified row when every remaining category is already loading", () => {
    const loadingCategory = SESSION_LIST_CATEGORIES[0] as SessionListCategory;
    const plan = getUnifiedPaginationPlan(
      makePagination({
        [loadingCategory]: streamState("loading"),
      }),
      true
    );
    const row = unifiedLoadMoreRow(plan!, "Loading");

    expect(plan).toEqual({
      targets: [{ category: loadingCategory, phase: "loading" }],
    });
    expect(row.disabled).toBe(true);
  });

  it("only matches the unified backend load-more id", () => {
    expect(isUnifiedLoadMoreId(UNIFIED_LOAD_MORE_ID)).toBe(true);
    expect(isUnifiedLoadMoreId("load-more-cursor_ide")).toBe(false);
  });

  it("loads every ready category", async () => {
    const firstReadyCategory =
      SESSION_LIST_CATEGORIES[1] as SessionListCategory;
    const secondReadyCategory =
      SESSION_LIST_CATEGORIES[2] as SessionListCategory;
    const loadCategory = vi.fn(() => Promise.resolve());

    const plan = getUnifiedPaginationPlan(
      makePagination({
        [firstReadyCategory]: streamState("ready"),
        [secondReadyCategory]: streamState("ready"),
      }),
      true
    );
    const result = executeSessionPaginationPlan({
      plan: plan!,
      loadCategory,
    });

    expect(result).toBeInstanceOf(Promise);
    await result;
    expect(loadCategory).toHaveBeenCalledTimes(2);
    expect(loadCategory).toHaveBeenNthCalledWith(1, firstReadyCategory);
    expect(loadCategory).toHaveBeenNthCalledWith(2, secondReadyCategory);
  });

  it("does not start another batch while any category is loading", () => {
    const loadingCategory = SESSION_LIST_CATEGORIES[0] as SessionListCategory;
    const readyCategory = SESSION_LIST_CATEGORIES[1] as SessionListCategory;
    const loadCategory = vi.fn(() => Promise.resolve());

    const plan = getUnifiedPaginationPlan(
      makePagination({
        [loadingCategory]: streamState("loading"),
        [readyCategory]: streamState("ready"),
      }),
      true
    );
    const result = executeSessionPaginationPlan({
      plan: plan!,
      loadCategory,
    });

    expect(result).toBeNull();
    expect(loadCategory).not.toHaveBeenCalled();
  });

  it("caps the unified footer at four concurrent stream requests", async () => {
    const ready = Object.fromEntries(
      SESSION_LIST_CATEGORIES.map((category) => [
        category,
        streamState("ready"),
      ])
    ) as Partial<SessionPaginationMap>;
    let active = 0;
    let maxActive = 0;
    const loadCategory = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
    });

    const plan = getUnifiedPaginationPlan(makePagination(ready), true);
    const result = executeSessionPaginationPlan({
      plan: plan!,
      loadCategory,
    });
    await result;

    expect(loadCategory).toHaveBeenCalledTimes(SESSION_LIST_CATEGORIES.length);
    expect(maxActive).toBe(4);
  });

  it("executes only the categories captured by the visible empty-scope retry", async () => {
    const failedCategory = SESSION_LIST_CATEGORIES[0] as SessionListCategory;
    const hiddenReadyCategory =
      SESSION_LIST_CATEGORIES[1] as SessionListCategory;
    const loadCategory = vi.fn(() => Promise.resolve());
    const plan = getUnifiedPaginationPlan(
      makePagination({
        [failedCategory]: streamState("error"),
        [hiddenReadyCategory]: streamState("ready"),
      }),
      false
    );

    expect(plan).toEqual({
      targets: [{ category: failedCategory, phase: "error" }],
    });
    const result = executeSessionPaginationPlan({
      plan: plan!,
      loadCategory,
    });

    await result;
    expect(loadCategory).toHaveBeenCalledOnce();
    expect(loadCategory).toHaveBeenCalledWith(failedCategory);
  });
});
