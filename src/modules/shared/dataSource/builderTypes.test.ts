import { describe, expect, it } from "vitest";

import {
  BUILDER_TYPES,
  BUILDER_TYPE_CODES,
  getBuilderType,
  isBuilderTypeCode,
} from "./builderTypes";

describe("builder type catalog", () => {
  it("covers every four-axis combination exactly once", () => {
    expect(BUILDER_TYPES).toHaveLength(16);
    expect(new Set(BUILDER_TYPES.map((type) => type.code)).size).toBe(16);
    expect(BUILDER_TYPES.map((type) => type.code)).toEqual(BUILDER_TYPE_CODES);
  });

  it("gives every type a unique portrait and readable name", () => {
    expect(new Set(BUILDER_TYPES.map((type) => type.avatar)).size).toBe(16);
    for (const type of BUILDER_TYPES) {
      expect(type.name.length).toBeGreaterThan(3);
      expect(type.letters.join("")).toBe(type.code);
    }
  });

  it("guards unknown wire values without inventing a type", () => {
    expect(isBuilderTypeCode("EAWH")).toBe(true);
    expect(isBuilderTypeCode("XXXX")).toBe(false);
    expect(getBuilderType("EAWH")?.name).toBe("Swarm Founder");
    expect(getBuilderType("XXXX")).toBeUndefined();
  });
});
