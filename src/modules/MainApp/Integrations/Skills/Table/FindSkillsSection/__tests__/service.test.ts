import { describe, expect, it } from "vitest";

import {
  normalizeSkillSearchQuery,
  sanitizeSkillFileSegment,
} from "../service";

describe("FindSkills service model", () => {
  it("normalizes searchable queries", () => {
    expect(normalizeSkillSearchQuery("  react  ")).toBe("react");
    expect(normalizeSkillSearchQuery(" a ")).toBeNull();
    expect(normalizeSkillSearchQuery("   ")).toBeNull();
  });

  it("creates filesystem-safe skill segments", () => {
    expect(sanitizeSkillFileSegment("org/skill name")).toBe("org-skill-name");
    expect(sanitizeSkillFileSegment("safe_name-1.0")).toBe("safe_name-1.0");
    expect(sanitizeSkillFileSegment("///")).toBe("---");
    expect(sanitizeSkillFileSegment("")).toBe("skill");
  });
});
