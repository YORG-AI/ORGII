import { describe, expect, it } from "vitest";

import { IMPORTED_HISTORY_SOURCES } from "@src/api/tauri/externalHistory";

import {
  SESSION_LIST_CATEGORIES,
  categoryCanLoadInScope,
  parseSessionPaginationScopeKey,
  resetPaginationState,
  sessionPaginationScopeKey,
} from "../paginationAtoms";

describe("session pagination categories", () => {
  const personalOrgIds = ["personal-org"] as const;

  it("includes one source-aware category per imported history source", () => {
    const importedCategories = IMPORTED_HISTORY_SOURCES.map(
      (source) => source.listCategory
    );

    expect(SESSION_LIST_CATEGORIES).toEqual([
      "cli_agent",
      "rust_agent:sde",
      "rust_agent:agent_org",
      "rust_agent:os",
      "rust_agent:wingman",
      "rust_agent:custom",
      "human_session",
      ...importedCategories,
    ]);
  });

  it("initializes pagination state for each source-specific imported category", () => {
    const state = resetPaginationState();

    expect(state["external_history:codex_app"]).toEqual({
      loaded: 0,
      hasMore: false,
      loading: false,
      generation: 0,
      requestToken: 0,
    });
    expect(state["external_history:claude_code"]).toEqual({
      loaded: 0,
      hasMore: false,
      loading: false,
      generation: 0,
      requestToken: 0,
    });
    expect(state["external_history:opencode"]).toEqual({
      loaded: 0,
      hasMore: false,
      loading: false,
      generation: 0,
      requestToken: 0,
    });
    expect(state["external_history:windsurf"]).toEqual({
      loaded: 0,
      hasMore: false,
      loading: false,
      generation: 0,
      requestToken: 0,
    });
    expect(state["external_history:warp"]).toEqual({
      loaded: 0,
      hasMore: false,
      loading: false,
      generation: 0,
      requestToken: 0,
    });
  });

  it("round-trips date and workspace scope keys without conflating missing workspace", () => {
    const workspace = {
      kind: "workspace" as const,
      repoPath: "/tmp/项目:alpha",
      orgIds: personalOrgIds,
    };
    const noWorkspace = {
      kind: "workspace" as const,
      repoPath: null,
      orgIds: personalOrgIds,
    };

    expect(
      parseSessionPaginationScopeKey(sessionPaginationScopeKey(workspace))
    ).toEqual(workspace);
    expect(
      parseSessionPaginationScopeKey(sessionPaginationScopeKey(noWorkspace))
    ).toEqual(noWorkspace);
    expect(parseSessionPaginationScopeKey("time:older")).toBeNull();
  });

  it("uses the requested imported date bucket instead of a source-wide hasMore", () => {
    const globalState = {
      loaded: 20,
      hasMore: true,
      loading: false,
      dateBuckets: {
        today: { loaded: 10, hasMore: true },
        yesterday: { loaded: 10, hasMore: false },
        thisWeek: { loaded: 0, hasMore: false },
        older: { loaded: 0, hasMore: false },
      },
    };

    expect(
      categoryCanLoadInScope(
        "external_history:codex_app",
        { kind: "time", bucket: "today", orgIds: personalOrgIds },
        globalState
      )
    ).toBe(true);
    expect(
      categoryCanLoadInScope(
        "external_history:codex_app",
        { kind: "time", bucket: "older", orgIds: personalOrgIds },
        globalState
      )
    ).toBe(false);
  });

  it("keeps category cursors independent across org A, org B, then org A", () => {
    const orgAScope = {
      kind: "category" as const,
      category: "rust_agent:sde" as const,
      orgIds: ["cloud:org-a", "org-a"],
    };
    const orgBScope = {
      kind: "category" as const,
      category: "rust_agent:sde" as const,
      orgIds: ["cloud:org-b", "org-b"],
    };

    expect(sessionPaginationScopeKey(orgAScope)).toBe(
      sessionPaginationScopeKey({
        ...orgAScope,
        orgIds: ["org-a", "cloud:org-a"],
      })
    );
    expect(sessionPaginationScopeKey(orgAScope)).not.toBe(
      sessionPaginationScopeKey(orgBScope)
    );
    expect(
      parseSessionPaginationScopeKey(sessionPaginationScopeKey(orgAScope))
    ).toEqual({
      ...orgAScope,
      orgIds: ["cloud:org-a", "org-a"],
    });
  });

  it("never opens imported-history cursors outside personal org", () => {
    const state = {
      loaded: 10,
      hasMore: true,
      loading: false,
    };
    expect(
      categoryCanLoadInScope(
        "external_history:codex_app",
        {
          kind: "category",
          category: "external_history:codex_app",
          orgIds: ["cloud:org-a", "org-a"],
        },
        state
      )
    ).toBe(false);
  });
});
