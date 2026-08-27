import { describe, expect, it } from "vitest";

import {
  MODEL_GROUP_SORT_MODE,
  getDefaultEnabledModels,
  getModelFamily,
  groupModels,
  isLegacyGroup,
  sortModelGroups,
} from "../modelGrouping";

describe("modelGrouping current thresholds", () => {
  it("treats GPT 5.2 and 5.3 as non-current", () => {
    const groups = groupModels(["gpt-5.2", "gpt-5.3"]);

    expect(groups.every(isLegacyGroup)).toBe(true);
  });

  it("treats GPT 5.4 and newer as current", () => {
    const groups = groupModels(["gpt-5.4", "gpt-5.5"]);

    expect(groups.every((group) => !isLegacyGroup(group))).toBe(true);
  });

  it("splits GPT sub-variants (nano/mini/codex) into their own groups", () => {
    const groups = groupModels([
      "gpt-5.4",
      "gpt-5.4-nano",
      "gpt-5.4-mini",
      "gpt-5.4-codex",
      "gpt-5.4-nano-high",
      "gpt-5.4-mini-high",
    ]);

    const byLabel = new Map(groups.map((group) => [group.label, group]));
    expect(byLabel.get("GPT 5.4")?.models).toEqual(["gpt-5.4"]);
    expect(byLabel.get("GPT 5.4 Nano")?.models).toEqual([
      "gpt-5.4-nano",
      "gpt-5.4-nano-high",
    ]);
    expect(byLabel.get("GPT 5.4 Mini")?.models).toEqual([
      "gpt-5.4-mini",
      "gpt-5.4-mini-high",
    ]);
    expect(byLabel.get("GPT 5.4 Codex")?.models).toEqual(["gpt-5.4-codex"]);
  });

  it("splits GPT codex-mini and codex-max into separate groups", () => {
    const groups = groupModels([
      "gpt-5.1-codex",
      "gpt-5.1-codex-high",
      "gpt-5.1-codex-mini",
      "gpt-5.1-codex-mini-high",
      "gpt-5.1-codex-max",
      "gpt-5.1-codex-max-high",
    ]);

    const byLabel = new Map(groups.map((group) => [group.label, group]));
    expect(byLabel.get("GPT 5.1 Codex")?.models).toEqual([
      "gpt-5.1-codex",
      "gpt-5.1-codex-high",
    ]);
    expect(byLabel.get("GPT 5.1 Codex Mini")?.models).toEqual([
      "gpt-5.1-codex-mini",
      "gpt-5.1-codex-mini-high",
    ]);
    expect(byLabel.get("GPT 5.1 Codex Max")?.models).toEqual([
      "gpt-5.1-codex-max",
      "gpt-5.1-codex-max-high",
    ]);
  });

  it("keeps Cursor tier models as standalone Cursor groups", () => {
    const groups = groupModels(["default", "auto", "premium"]);
    const byLabel = new Map(groups.map((group) => [group.label, group]));

    expect(byLabel.get("Default")?.models).toEqual(["default"]);
    expect(byLabel.get("Auto")?.models).toEqual(["auto"]);
    expect(byLabel.get("Premium")?.models).toEqual(["premium"]);
    expect(getModelFamily("default")).toBe("Cursor");
    expect(getModelFamily("auto")).toBe("Cursor");
    expect(getModelFamily("premium")).toBe("Cursor");
  });

  it("splits O-series minor versions into separate groups like GPT", () => {
    const groups = groupModels([
      "o5-chat",
      "o5.4",
      "o5.4-high",
      "o5.4-low",
      "o5.4-mini",
      "o5.4-minimal",
      "o5.4-nano",
      "o5.5",
      "o5.5-high",
      "o5.5-low",
      "o5.5-minimal",
    ]);

    const byLabel = new Map(groups.map((group) => [group.label, group]));
    expect(byLabel.get("o5")?.models).toEqual(["o5-chat"]);
    expect(byLabel.get("o5.4")?.models).toEqual([
      "o5.4",
      "o5.4-high",
      "o5.4-low",
      "o5.4-mini",
      "o5.4-minimal",
      "o5.4-nano",
    ]);
    expect(byLabel.get("o5.5")?.models).toEqual([
      "o5.5",
      "o5.5-high",
      "o5.5-low",
      "o5.5-minimal",
    ]);
  });

  it("treats o5 and o5.4 legacy status like GPT 5.3 vs 5.4", () => {
    const groups = groupModels(["o5-chat", "o5.4", "o5.5"]);
    const byLabel = new Map(groups.map((group) => [group.label, group]));

    expect(isLegacyGroup(byLabel.get("o5")!)).toBe(true);
    expect(isLegacyGroup(byLabel.get("o5.4")!)).toBe(false);
    expect(isLegacyGroup(byLabel.get("o5.5")!)).toBe(false);
  });

  it("treats Zhipu GLM 5.1+ as current and older GLM lines as non-current", () => {
    const groups = groupModels([
      "glm-4.5",
      "glm-4.6",
      "glm-5",
      "glm-5-turbo",
      "glm-5.1",
      "glm-5.2",
    ]);
    const byLabel = new Map(groups.map((group) => [group.label, group]));

    expect(isLegacyGroup(byLabel.get("GLM 4.5")!)).toBe(true);
    expect(isLegacyGroup(byLabel.get("GLM 4.6")!)).toBe(true);
    expect(isLegacyGroup(byLabel.get("GLM 5")!)).toBe(true);
    expect(isLegacyGroup(byLabel.get("GLM 5.1")!)).toBe(false);
    expect(isLegacyGroup(byLabel.get("GLM 5.2")!)).toBe(false);
    expect(byLabel.get("GLM 5")?.models).toEqual(["glm-5", "glm-5-turbo"]);
  });

  it("treats MiniMax 2.7 and 3+ as current and older MiniMax lines as non-current", () => {
    const groups = groupModels([
      "minimax/minimax-m1",
      "minimax/minimax-m2",
      "minimax/minimax-m2.5",
      "minimax/minimax-m2.7",
      "minimax/minimax-m3",
    ]);
    const byLabel = new Map(groups.map((group) => [group.label, group]));

    expect(isLegacyGroup(byLabel.get("MiniMax 1")!)).toBe(true);
    expect(isLegacyGroup(byLabel.get("MiniMax 2")!)).toBe(true);
    expect(isLegacyGroup(byLabel.get("MiniMax 2.5")!)).toBe(true);
    expect(isLegacyGroup(byLabel.get("MiniMax 2.7")!)).toBe(false);
    expect(isLegacyGroup(byLabel.get("MiniMax 3")!)).toBe(false);
  });

  it("keeps uncategorized models as separate single-model groups", () => {
    const groups = groupModels([
      "my-custom-model",
      "vendor/foo-bar",
      "gpt-5.4",
    ]);

    expect(groups).toHaveLength(3);
    expect(
      groups.find((group) => group.label === "my-custom-model")?.models
    ).toEqual(["my-custom-model"]);
    expect(
      groups.find((group) => group.label === "vendor/foo-bar")?.models
    ).toEqual(["vendor/foo-bar"]);
    expect(groups.find((group) => group.label === "GPT 5.4")?.models).toEqual([
      "gpt-5.4",
    ]);
  });

  it("does not group non-standard op-* manual model ids under O-series", () => {
    const groups = groupModels(["op-4.5", "op-4.6-relay", "o5-chat"]);

    expect(groups).toHaveLength(3);
    expect(groups.find((group) => group.label === "op-4.5")?.models).toEqual([
      "op-4.5",
    ]);
    expect(
      groups.find((group) => group.label === "op-4.6-relay")?.models
    ).toEqual(["op-4.6-relay"]);
    expect(groups.find((group) => group.label === "o5")?.models).toEqual([
      "o5-chat",
    ]);
  });
});

describe("sortModelGroups", () => {
  const groups = groupModels(["gpt-5.4", "gpt-5.2", "claude-4.6-opus"]);

  it("puts enabled groups first, then by generation", () => {
    const enabledSet = new Set(["gpt-5.2"]);
    const sorted = sortModelGroups(
      groups,
      MODEL_GROUP_SORT_MODE.ENABLED_FIRST,
      enabledSet
    );

    expect(sorted[0].label).toBe("GPT 5.2");
    expect(sorted.slice(1).map((group) => group.label)).toEqual([
      "GPT 5.4",
      "Opus 4.6",
    ]);
  });

  it("sorts alphabetically by group label", () => {
    const sorted = sortModelGroups(
      groups,
      MODEL_GROUP_SORT_MODE.ALPHABETICAL,
      new Set()
    );

    expect(sorted.map((group) => group.label)).toEqual([
      "GPT 5.2",
      "GPT 5.4",
      "Opus 4.6",
    ]);
  });
});

describe("getDefaultEnabledModels", () => {
  it("preselects only current Zhipu GLM lines by default", () => {
    const enabled = getDefaultEnabledModels([
      "glm-4.7",
      "glm-5",
      "glm-5.1",
      "glm-5.2",
    ]);

    expect(enabled).toEqual(["glm-5.2", "glm-5.1"]);
  });

  it("preselects only current MiniMax lines by default", () => {
    const enabled = getDefaultEnabledModels([
      "minimax/minimax-m2.5",
      "minimax/minimax-m2.7",
      "minimax/minimax-m3",
    ]);

    expect(enabled).toEqual(["minimax/minimax-m3", "minimax/minimax-m2.7"]);
  });
});
