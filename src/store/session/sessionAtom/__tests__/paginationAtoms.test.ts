import { describe, expect, it } from "vitest";

import { IMPORTED_HISTORY_SOURCES } from "@src/api/tauri/externalHistory";

import {
  SESSION_LIST_CATEGORIES,
  resetPaginationState,
} from "../paginationAtoms";

describe("session pagination categories", () => {
  it("includes one source-aware category per imported history source", () => {
    const importedCategories = IMPORTED_HISTORY_SOURCES.map(
      (source) => source.listCategory
    );

    expect(SESSION_LIST_CATEGORIES).toEqual([
      "cli_agent",
      "rust_agent",
      ...importedCategories,
    ]);
  });

  it("initializes pagination state for each source-specific imported category", () => {
    const state = resetPaginationState();

    expect(state["external_history:codex_app"]).toEqual({
      loaded: 0,
      hasMore: false,
      loading: false,
    });
    expect(state["external_history:claude_code"]).toEqual({
      loaded: 0,
      hasMore: false,
      loading: false,
    });
    expect(state["external_history:opencode"]).toEqual({
      loaded: 0,
      hasMore: false,
      loading: false,
    });
    expect(state["external_history:windsurf"]).toEqual({
      loaded: 0,
      hasMore: false,
      loading: false,
    });
    expect(state["external_history:warp"]).toEqual({
      loaded: 0,
      hasMore: false,
      loading: false,
    });
    expect(state["external_history:qoder"]).toEqual({
      loaded: 0,
      hasMore: false,
      loading: false,
    });
  });
});
