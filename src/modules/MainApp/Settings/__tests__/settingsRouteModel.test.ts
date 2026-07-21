import { describe, expect, it } from "vitest";

import { resolveSettingsRoute } from "../settingsRouteModel";

describe("Settings route model", () => {
  it.each([
    [
      "/orgii/app/settings/notifications",
      "/orgii/app/settings/app/general/notifications",
    ],
    [
      "/orgii/app/settings/shortcuts",
      "/orgii/app/settings/app/general/shortcuts",
    ],
    [
      "/orgii/app/settings/code-search-indexing",
      "/orgii/app/settings/app/editor/index",
    ],
    ["/orgii/app/settings/workspace", "/orgii/app/settings/app/editor/index"],
  ])("canonicalizes %s", (pathname, expected) => {
    expect(resolveSettingsRoute(pathname).canonicalPath).toBe(expected);
  });

  it("keeps bare settings landings in place", () => {
    expect(resolveSettingsRoute("/orgii/app/settings")).toMatchObject({
      activeSection: "general",
      activeSectionTab: "general",
      canonicalPath: null,
    });
  });

  it("falls back unknown tails to the default app section", () => {
    expect(
      resolveSettingsRoute("/orgii/app/settings/not-a-section")
    ).toMatchObject({
      activeSection: "general",
      activeSectionTab: "general",
      canonicalPath: "/orgii/app/settings/app/general",
    });
  });

  it("preserves valid section tabs", () => {
    expect(
      resolveSettingsRoute("/orgii/app/settings/appearance/chat-panel")
    ).toMatchObject({
      activeSection: "appearance",
      activeSectionTab: "chat-panel",
      canonicalPath: null,
    });
  });

  it("recognizes the editor appearance subpage", () => {
    expect(
      resolveSettingsRoute("/orgii/app/settings/subpage/editor-appearance")
    ).toMatchObject({
      subpage: "editor-appearance",
      canonicalPath: null,
    });
  });
});
