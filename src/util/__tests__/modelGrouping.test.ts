import type { ModelGroup } from "../modelGrouping";
import {
  getDefaultEnabledModels,
  getModelFamily,
  groupModels,
  isLegacyGroup,
} from "../modelGrouping";

describe("groupModels", () => {
  it("groups Claude models by version (claude-3-5-sonnet-20241022 → Sonnet 3.5)", () => {
    const groups = groupModels(["claude-3-5-sonnet-20241022"]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      label: "Sonnet 3.5",
      sortVersion: 305,
      models: ["claude-3-5-sonnet-20241022"],
    });
  });

  it("groups Claude models with decimal version (claude-4.5-sonnet → Sonnet 4.5)", () => {
    const groups = groupModels(["claude-4.5-sonnet"]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      label: "Sonnet 4.5",
      sortVersion: 405,
      models: ["claude-4.5-sonnet"],
    });
  });

  it("groups Claude models with reversed name-version format (claude-opus-4-7 → Opus 4.7)", () => {
    const groups = groupModels(["claude-opus-4-7"]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      label: "Opus 4.7",
      sortVersion: 407,
      models: ["claude-opus-4-7"],
    });
  });

  it("groups GPT models (gpt-4-turbo → GPT 4)", () => {
    const groups = groupModels(["gpt-4-turbo"]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      label: "GPT 4",
      sortVersion: 400,
      models: ["gpt-4-turbo"],
    });
  });

  it("groups Gemini models (gemini-2.0-flash → Gemini 2.0)", () => {
    const groups = groupModels(["gemini-2.0-flash"]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      label: "Gemini 2.0",
      sortVersion: 200,
      models: ["gemini-2.0-flash"],
    });
  });

  it("groups O-series models correctly (o3-mini → o3)", () => {
    const groups = groupModels(["o3-mini"]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      label: "o3",
      sortVersion: 300,
      models: ["o3-mini"],
    });
  });

  it("sorts groups by sortVersion descending", () => {
    const groups = groupModels([
      "gpt-4-turbo",
      "gpt-5.3-pro",
      "claude-4-1-sonnet",
    ]);
    expect(groups.map((group) => group.label)).toEqual([
      "GPT 5.3",
      "Sonnet 4.1",
      "GPT 4",
    ]);
  });

  it("returns empty array for empty input", () => {
    expect(groupModels([])).toEqual([]);
  });
  it("treats fable as a Claude sub-family (claude-fable-5 → Fable 5)", () => {
    const groups = groupModels(["claude-fable-5"]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      label: "Fable 5",
      sortVersion: 500,
      models: ["claude-fable-5"],
    });
  });

  it("groups claude-fable-5-1 as its own newer Fable 5.1 group", () => {
    const groups = groupModels(["claude-fable-5", "claude-fable-5-1"]);
    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.label)).toEqual([
      "Fable 5.1",
      "Fable 5",
    ]);
    expect(groups[0]).toMatchObject({
      label: "Fable 5.1",
      sortVersion: 501,
      models: ["claude-fable-5-1"],
    });
  });

  it("treats mythos as a Claude sub-family (claude-mythos-5 → Mythos 5)", () => {
    const groups = groupModels(["claude-mythos-5"]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      label: "Mythos 5",
      sortVersion: 500,
      models: ["claude-mythos-5"],
    });
  });

  it("falls back to bare Claude + version when no codename or canonical name is present (claude-5)", () => {
    const groups = groupModels(["claude-5"]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      label: "Claude 5",
      sortVersion: 500,
    });
  });
});

describe("getDefaultEnabledModels", () => {
  it("returns current generation models and excludes older generation models", () => {
    const allModels = [
      "gpt-4-turbo",
      "gpt-5.5-pro",
      "gemini-1.5-flash",
      "gemini-2.0-flash",
    ];
    const enabled = getDefaultEnabledModels(allModels);
    expect(enabled).toEqual(
      expect.arrayContaining(["gpt-5.5-pro", "gemini-2.0-flash"])
    );
    expect(enabled).not.toContain("gpt-4-turbo");
    expect(enabled).not.toContain("gemini-1.5-flash");
  });
});

describe("isLegacyGroup", () => {
  it("treats Claude 4.5 (405) as legacy (< 406)", () => {
    const group: ModelGroup = {
      label: "Sonnet 4.5",
      sortVersion: 405,
      models: [],
    };
    expect(isLegacyGroup(group)).toBe(true);
  });

  it("treats Claude 3.5 (305) as legacy (< 406)", () => {
    const group: ModelGroup = {
      label: "Sonnet 3.5",
      sortVersion: 305,
      models: [],
    };
    expect(isLegacyGroup(group)).toBe(true);
  });

  it("treats Claude 4.6 (406) as current", () => {
    const group: ModelGroup = {
      label: "Sonnet 4.6",
      sortVersion: 406,
      models: [],
    };
    expect(isLegacyGroup(group)).toBe(false);
  });

  it("treats GPT 4 (400) as legacy (< 540)", () => {
    const group: ModelGroup = {
      label: "GPT 4",
      sortVersion: 400,
      models: [],
    };
    expect(isLegacyGroup(group)).toBe(true);
  });
});

describe("getModelFamily", () => {
  it("maps claude-3-5-sonnet-20241022 to Claude", () => {
    expect(getModelFamily("claude-3-5-sonnet-20241022")).toBe("Claude");
  });

  it("maps gpt-4-turbo to OpenAI", () => {
    expect(getModelFamily("gpt-4-turbo")).toBe("OpenAI");
  });

  it("maps gemini-2.0-flash to Gemini", () => {
    expect(getModelFamily("gemini-2.0-flash")).toBe("Gemini");
  });

  it("maps o3-mini to OpenAI", () => {
    expect(getModelFamily("o3-mini")).toBe("OpenAI");
  });

  it("maps unknown-model to Other", () => {
    expect(getModelFamily("unknown-model")).toBe("Other");
  });
});
