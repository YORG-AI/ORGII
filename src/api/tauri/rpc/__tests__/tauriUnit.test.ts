import { describe, expect, it } from "vitest";

import { TauriUnitSchema } from "../schemas/tauriUnit";

describe("Tauri unit response schema", () => {
  it("normalizes Rust unit null to TypeScript undefined", () => {
    expect(TauriUnitSchema.parse(null)).toBeUndefined();
  });

  it("rejects a missing or non-unit response", () => {
    expect(TauriUnitSchema.safeParse(undefined).success).toBe(false);
    expect(TauriUnitSchema.safeParse({}).success).toBe(false);
  });
});
