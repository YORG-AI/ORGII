import { describe, expect, it } from "vitest";

import {
  formatSkillFrontmatterPropertyLabel,
  parseSkillFrontmatter,
} from "@src/util/skills/skillFrontmatter";

describe("formatSkillFrontmatterPropertyLabel", () => {
  it("formats frontmatter keys as title case labels", () => {
    expect(formatSkillFrontmatterPropertyLabel("name")).toBe("Name");
    expect(
      formatSkillFrontmatterPropertyLabel("disable-model-invocation")
    ).toBe("Disable Model Invocation");
    expect(formatSkillFrontmatterPropertyLabel("argument_hint")).toBe(
      "Argument Hint"
    );
  });
});

describe("parseSkillFrontmatter", () => {
  it("parses folded YAML block scalars in skill descriptions", () => {
    const parsed = parseSkillFrontmatter(`---
name: create-subagent
description: >-
  Create custom subagents for specialized AI tasks. Use when you want to create
  a new type of subagent, set up task-specific agents, configure code reviewers,
  debuggers, or domain-specific assistants with custom prompts.
disable-model-invocation: true
---

# Creating Custom Subagents
`);

    expect(parsed?.frontmatter).toMatchObject({
      name: "create-subagent",
      description:
        "Create custom subagents for specialized AI tasks. Use when you want to create a new type of subagent, set up task-specific agents, configure code reviewers, debuggers, or domain-specific assistants with custom prompts.",
      "disable-model-invocation": true,
    });
    expect(parsed?.body).toBe("# Creating Custom Subagents\n");
  });
});
