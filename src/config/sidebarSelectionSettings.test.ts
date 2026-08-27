import { describe, expect, it } from "vitest";

import {
  getSettingsDefaults,
  validateSettings,
} from "@src/config/settingsSchema";

describe("git prompt instructions", () => {
  it("defaults both prompts to empty strings", () => {
    const defaults = getSettingsDefaults();

    expect(defaults["git.prompts.commitInstructions"]).toBe("");
    expect(defaults["git.prompts.pullRequestInstructions"]).toBe("");
  });

  it("accepts independent multiline prompt values at the 4000-character limit", () => {
    const commitInstructions = `${"x".repeat(3989)}\n使用中文并包含正文。`;
    const pullRequestInstructions = "Prefix the title with #305.";
    const settings = validateSettings({
      "git.prompts.commitInstructions": commitInstructions,
      "git.prompts.pullRequestInstructions": pullRequestInstructions,
    });

    expect(commitInstructions).toHaveLength(4000);
    expect(settings["git.prompts.commitInstructions"]).toBe(commitInstructions);
    expect(settings["git.prompts.pullRequestInstructions"]).toBe(
      pullRequestInstructions
    );
  });

  it("rejects prompt values over 4000 characters", () => {
    const settings = validateSettings({
      "git.prompts.commitInstructions": "x".repeat(4001),
    });

    expect(settings["git.prompts.commitInstructions"]).toBe("");
  });
});

describe("sidebar item appearance", () => {
  it("uses the Codex-equivalent selection default", () => {
    expect(getSettingsDefaults()["layout.sidebarSelectedRowOpacity"]).toBe(5);
  });

  it("accepts a user-selected highlight intensity", () => {
    expect(
      validateSettings({ "layout.sidebarSelectedRowOpacity": 12 })[
        "layout.sidebarSelectedRowOpacity"
      ]
    ).toBe(12);
  });

  it("enables the sidebar edge depth by default", () => {
    expect(getSettingsDefaults()["layout.sidebarEdgeDepthEnabled"]).toBe(true);
  });

  it("accepts disabling the sidebar edge depth", () => {
    expect(
      validateSettings({ "layout.sidebarEdgeDepthEnabled": false })[
        "layout.sidebarEdgeDepthEnabled"
      ]
    ).toBe(false);
  });
});
