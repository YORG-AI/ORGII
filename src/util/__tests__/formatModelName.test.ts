import {
  compactModelLabel,
  compareModelsByVersion,
  formatModelName,
  formatModelNameFull,
  resolveModelDisplayLabel,
  resolveModelFullLabel,
} from "../formatModelName";

describe("formatModelName", () => {
  it("formats claude opus with date stripped", () => {
    expect(formatModelName("claude-opus-4.5-20251219")).toBe("Opus 4.5");
  });

  it("merges digit segments for claude 3.5 sonnet", () => {
    expect(formatModelName("claude-3-5-sonnet-20241022")).toBe("Sonnet 3.5");
  });

  it("formats gpt-4-turbo with date stripped", () => {
    expect(formatModelName("gpt-4-turbo-2024-04-09")).toBe("GPT 4 Turbo");
  });

  it("uppercases o3 token", () => {
    expect(formatModelName("o3-mini-2025-01-31")).toBe("O3 Mini");
  });

  it("formats gemini 2.0 flash", () => {
    expect(formatModelName("gemini-2.0-flash")).toBe("Gemini 2.0 Flash");
  });

  it("returns empty string for empty input", () => {
    expect(formatModelName("")).toBe("");
  });

  it("returns default unchanged", () => {
    expect(formatModelName("default")).toBe("default");
  });

  it("filters out long hex-like segments", () => {
    const longHex = "a".repeat(13);
    expect(formatModelName(`foo-${longHex}-bar`)).toBe("Foo Bar");
  });

  it("strips -latest suffix", () => {
    expect(formatModelName("gpt-4-latest")).toBe("GPT 4");
  });

  it("treats fable as a Claude sub-family (claude-fable-5 → Fable 5)", () => {
    expect(formatModelName("claude-fable-5")).toBe("Fable 5");
  });

  it("reads the fable minor version (claude-fable-5-1 → Fable 5.1)", () => {
    expect(formatModelName("claude-fable-5-1")).toBe("Fable 5.1");
  });

  it("treats mythos as a Claude sub-family (claude-mythos-5 → Mythos 5)", () => {
    expect(formatModelName("claude-mythos-5")).toBe("Mythos 5");
  });
});

describe("formatModelNameFull", () => {
  it("preserves ISO-style date for gpt-5.2", () => {
    expect(formatModelNameFull("gpt-5.2-2025-12-11")).toBe(
      "GPT 5.2 2025-12-11"
    );
  });

  it("preserves compact date for claude opus", () => {
    expect(formatModelNameFull("claude-opus-4.5-20251219")).toBe(
      "Opus 4.5 20251219"
    );
  });

  it("matches formatModelName when there is no trailing junk", () => {
    const base = formatModelName("gemini-2.0-flash");
    expect(formatModelNameFull("gemini-2.0-flash")).toBe(base);
  });
});

describe("compactModelLabel", () => {
  it("strips Claude prefix from opus label", () => {
    expect(compactModelLabel("Claude Opus 4.5")).toBe("Opus 4.5");
  });

  it("strips Claude prefix from sonnet label", () => {
    expect(compactModelLabel("Claude 3.5 Sonnet")).toBe("Sonnet 3.5");
  });

  it("leaves GPT labels unchanged", () => {
    expect(compactModelLabel("GPT 4 Turbo")).toBe("GPT 4 Turbo");
  });
});

describe("compareModelsByVersion", () => {
  it("same family: higher version sorts first (negative when first arg is newer)", () => {
    expect(
      compareModelsByVersion("gpt-5.4", "gpt-5.2-2025-12-11")
    ).toBeLessThan(0);
  });

  it("different families: alphabetical by family key", () => {
    expect(compareModelsByVersion("claude-3-opus", "gpt-4")).toBeLessThan(0);
    expect(compareModelsByVersion("gpt-4", "claude-3-opus")).toBeGreaterThan(0);
  });

  it("same family and version: falls back to localeCompare on raw ids", () => {
    const a = "gpt-4-turbo-a";
    const b = "gpt-4-turbo-b";
    expect(compareModelsByVersion(a, b)).toBe(a.localeCompare(b));
  });
});

const emptyProviders: {
  provider_name: string;
  models: { id: string; display_name: string }[];
}[] = [];

const sampleProviders = [
  {
    provider_name: "openai",
    models: [
      { id: "gpt-4o", display_name: "GPT-4o Display" },
      {
        id: "gpt-4o-2024-08-06",
        display_name: "Should not be used for id path",
      },
    ],
  },
  {
    provider_name: "anthropic",
    models: [
      {
        id: "claude-3-5-sonnet-20241022",
        display_name: "Claude Sonnet Display",
      },
    ],
  },
];

describe("resolveModelDisplayLabel", () => {
  it("uses listingModelDisplay first", () => {
    expect(
      resolveModelDisplayLabel(
        { listingModelDisplay: "Claude Opus 4.5" },
        sampleProviders
      )
    ).toBe("Opus 4.5");
  });

  it("falls back to listingName", () => {
    expect(
      resolveModelDisplayLabel(
        { listingName: "Claude Haiku 3" },
        sampleProviders
      )
    ).toBe("Haiku 3");
  });

  it("falls back to listingModel with formatModelNameFull + compact", () => {
    expect(
      resolveModelDisplayLabel(
        { listingModel: "gpt-4o-2024-08-06" },
        emptyProviders
      )
    ).toBe("GPT 4o 2024-08-06");
  });

  it("falls back to provider match when provider and model id match", () => {
    expect(
      resolveModelDisplayLabel(
        { provider: "openai", model: "gpt-4o" },
        sampleProviders
      )
    ).toBe("GPT 4o");
  });

  it("finds model across any provider when provider omitted", () => {
    expect(resolveModelDisplayLabel({ model: "gpt-4o" }, sampleProviders)).toBe(
      "GPT 4o"
    );
  });

  it("falls back to formatModelNameFull when no provider match", () => {
    expect(
      resolveModelDisplayLabel(
        { model: "custom-model-20250101" },
        emptyProviders
      )
    ).toBe("Custom Model 20250101");
  });

  it("returns fallback when no model fields", () => {
    expect(resolveModelDisplayLabel({}, emptyProviders, "No model")).toBe(
      "No model"
    );
  });
});

describe("resolveModelFullLabel", () => {
  it("compacts listingModelDisplay", () => {
    expect(
      resolveModelFullLabel({ listingModelDisplay: "Claude Opus 4.5" })
    ).toBe("Opus 4.5");
  });

  it("compacts listingName", () => {
    expect(resolveModelFullLabel({ listingName: "Claude 3.5 Sonnet" })).toBe(
      "Sonnet 3.5"
    );
  });

  it("uses formatModelNameFull for listingModel", () => {
    expect(resolveModelFullLabel({ listingModel: "gpt-5.2-2025-12-11" })).toBe(
      "GPT 5.2 2025-12-11"
    );
  });

  it("returns fallback when no model", () => {
    expect(resolveModelFullLabel({}, "Unknown")).toBe("Unknown");
  });

  it("uses formatModelNameFull on selection.model (ignores provider display_name)", () => {
    expect(
      resolveModelFullLabel({
        provider: "openai",
        model: "gpt-4o-2024-08-06",
      })
    ).toBe("GPT 4o 2024-08-06");
  });
});
