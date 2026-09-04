import { describe, expect, it } from "vitest";

import {
  Add01Icon,
  FolderGitTwoIcon,
  Login01Icon,
  MessageAdd02Icon,
  Search01Icon,
} from "@src/icons";

import {
  AGENT_SESSION_ACTIONS,
  ALL_SESSIONS_SEARCH_ICON,
  ORGANIZATION_ACTIONS,
  WORKSPACE_ACTIONS,
} from "../spotlightActionDefinitions.navigation";

describe("Spotlight action icons", () => {
  it("matches the sidebar icon for the new-session action", () => {
    const newSession = AGENT_SESSION_ACTIONS.find(
      (action) => action.id === "open-session-creator"
    );

    expect(newSession?.icon).toBe(MessageAdd02Icon);
  });

  it("uses the repository glyph when switching workspaces", () => {
    const switchWorkspace = WORKSPACE_ACTIONS.find(
      (action) => action.id === "switch-workspace"
    );

    expect(switchWorkspace?.icon).toBe(FolderGitTwoIcon);
  });

  it("distinguishes metadata search from full-text session search", () => {
    const metadataSearch = AGENT_SESSION_ACTIONS.find(
      (action) => action.id === "search-agent-sessions"
    );
    const fullTextSearch = AGENT_SESSION_ACTIONS.find(
      (action) => action.id === "search-all-sessions"
    );

    expect(metadataSearch?.icon).toBe(Search01Icon);
    // Under lucide this asserted `displayName === "DatabaseSearch"`. Hugeicons
    // icons are data, not components, so identity is asserted on the glyph's
    // actual shape: the custom database-search mark is five elements, the last
    // two being the search lens and its handle.
    expect(ALL_SESSIONS_SEARCH_ICON).toHaveLength(5);
    expect(ALL_SESSIONS_SEARCH_ICON.map(([tag]) => tag)).toEqual([
      "path",
      "path",
      "path",
      "circle",
      "path",
    ]);
    expect(fullTextSearch?.icon).toBe(ALL_SESSIONS_SEARCH_ICON);
    expect(fullTextSearch?.icon).not.toBe(metadataSearch?.icon);
  });

  it("exposes create and join organization as second-level Spotlight commands", () => {
    expect(ORGANIZATION_ACTIONS).toEqual([
      expect.objectContaining({
        id: "create-organization",
        icon: Add01Icon,
        payload: { mode: "create" },
        fallback: "organization-create",
        opensSecondLevel: true,
        closeOnSuccess: false,
      }),
      expect.objectContaining({
        id: "join-organization",
        icon: Login01Icon,
        payload: { source: "cloud", mode: "join" },
        fallback: "organization-join",
        opensSecondLevel: true,
        closeOnSuccess: false,
      }),
    ]);
  });
});
