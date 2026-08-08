import { describe, expect, it } from "vitest";

import { DEFAULT_WIZARD_DATA } from "../config";
import { buildModelVariantsForSave } from "./wizardModelMetadata";

describe("buildModelVariantsForSave", () => {
  it("persists provider-discovered variants that are not base catalog rows", () => {
    const variants = buildModelVariantsForSave(
      {
        ...DEFAULT_WIZARD_DATA,
        available_models: ["gpt-5.6-sol"],
        model_context_lengths: { "gpt-5.6-sol": 1_050_000 },
        model_variants: [
          {
            model: "gpt-5.6-sol-high-fast",
            baseModel: "gpt-5.6-sol",
            reasoning: "high",
            fast: true,
            contextWindow: 1_050_000,
          },
        ],
      },
      ["gpt-5.6-sol"]
    );

    expect(variants).toEqual([
      {
        model: "gpt-5.6-sol-high-fast",
        base_model: "gpt-5.6-sol",
        reasoning: "high",
        fast: true,
        context_window: 1_050_000,
      },
      {
        model: "gpt-5.6-sol",
        base_model: "gpt-5.6-sol",
        reasoning: undefined,
        fast: false,
        context_window: 1_050_000,
      },
    ]);
  });
});
