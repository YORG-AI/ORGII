import { describe, expect, it } from "vitest";

import { MODEL_REASONING_LEVEL } from "../modelVariants";
import { buildVariantEditOptions } from "../variantEditOptions";

describe("buildVariantEditOptions", () => {
  it.each(["gpt-5.6-sol", "gpt-5.6-terra"])(
    "matches the %s Codex menu while preserving Max and Ultra request identities",
    (base) => {
      // Discovery order must not determine the slider's effort order.
      const options = buildVariantEditOptions(
        ["ultra", "max", "xhigh", "high", "medium", "low"].flatMap((effort) => [
          `${base}-${effort}`,
          `${base}-${effort}-fast`,
        ])
      );
      expect(options.getAvailableLevels()).toEqual([
        MODEL_REASONING_LEVEL.LOW,
        MODEL_REASONING_LEVEL.MEDIUM,
        MODEL_REASONING_LEVEL.HIGH,
        MODEL_REASONING_LEVEL.EXTRA_HIGH,
        MODEL_REASONING_LEVEL.ULTRA,
      ]);
      for (const level of [
        MODEL_REASONING_LEVEL.MAX,
        MODEL_REASONING_LEVEL.ULTRA,
      ]) {
        for (const fast of [false, true]) {
          const id = `${base}-${level}${fast ? "-fast" : ""}`;
          expect(options.parseSelection(id)).toEqual({
            thinking: false,
            level,
            fast,
          });
          expect(
            options.resolveVariantId({ thinking: false, level, fast })
          ).toBe(id);
        }
      }
      // Existing persisted Max remains accurately editable, including Fast.
      // The menu only stops advertising it as a new selection.
      expect(options.getAvailableLevels(MODEL_REASONING_LEVEL.MAX)).toEqual([
        MODEL_REASONING_LEVEL.LOW,
        MODEL_REASONING_LEVEL.MEDIUM,
        MODEL_REASONING_LEVEL.HIGH,
        MODEL_REASONING_LEVEL.EXTRA_HIGH,
        MODEL_REASONING_LEVEL.MAX,
        MODEL_REASONING_LEVEL.ULTRA,
      ]);
    }
  );

  it("does not invent Ultra for Luna or older models", () => {
    for (const [base, efforts, highest] of [
      [
        "gpt-5.6-luna",
        ["low", "medium", "high", "xhigh", "max"],
        MODEL_REASONING_LEVEL.EXTRA_HIGH,
      ],
      [
        "gpt-5.5",
        ["low", "medium", "high", "xhigh"],
        MODEL_REASONING_LEVEL.EXTRA_HIGH,
      ],
    ] as const) {
      const options = buildVariantEditOptions(
        efforts.map((effort) => `${base}-${effort}`)
      );
      expect(options.getAvailableLevels().at(-1)).toBe(highest);
      expect(options.getAvailableLevels()).not.toContain(
        MODEL_REASONING_LEVEL.ULTRA
      );
      expect(
        options.resolveVariantId({
          thinking: false,
          level: MODEL_REASONING_LEVEL.ULTRA,
          fast: false,
        })
      ).toBeUndefined();
    }
  });

  it("keeps other model families' Max option", () => {
    for (const base of ["claude-opus-4-7", "grok-4.5"]) {
      const options = buildVariantEditOptions([`${base}-high`, `${base}-max`]);
      expect(options.getAvailableLevels()).toEqual([
        MODEL_REASONING_LEVEL.HIGH,
        MODEL_REASONING_LEVEL.MAX,
      ]);
    }
  });
});
