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
      "pinned_native",
      "cli_agent",
      "standalone_agent",
      "agent_org_root",
      "os_agent",
      "human_session",
      ...importedCategories,
    ]);
  });

  it("initializes pagination state for each source-specific imported category", () => {
    const state = resetPaginationState();

    expect(state["external_history:codex_app"]).toEqual({
      sessionIds: [],
      cursor: null,
      phase: "ready",
      generation: 0,
    });
    expect(state["external_history:claude_code"]).toEqual({
      sessionIds: [],
      cursor: null,
      phase: "ready",
      generation: 0,
    });
    expect(state["external_history:opencode"]).toEqual({
      sessionIds: [],
      cursor: null,
      phase: "ready",
      generation: 0,
    });
    expect(state["external_history:windsurf"]).toEqual({
      sessionIds: [],
      cursor: null,
      phase: "ready",
      generation: 0,
    });
    expect(state["external_history:warp"]).toEqual({
      sessionIds: [],
      cursor: null,
      phase: "ready",
      generation: 0,
    });
  });
});
