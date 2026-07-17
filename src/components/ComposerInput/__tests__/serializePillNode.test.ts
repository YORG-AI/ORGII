import { describe, expect, it } from "vitest";

import { sanitizePillDisplayLabel, serializePillNode } from "../utils";

// ============================================================
// sanitizePillDisplayLabel
// ============================================================

describe("sanitizePillDisplayLabel", () => {
  it("keeps single-token names unchanged", () => {
    expect(sanitizePillDisplayLabel("package.json")).toBe("package.json");
  });

  it("collapses whitespace runs into single hyphens", () => {
    expect(sanitizePillDisplayLabel("my session  title")).toBe(
      "my-session-title"
    );
  });

  it("handles CJK titles with spaces (regression: 啊p… mangle)", () => {
    expect(
      sanitizePillDisplayLabel("全面审计tools，包括policy 啊permission那些...")
    ).toBe("全面审计tools，包括policy-啊permission那些...");
  });

  it("strips square brackets that would break the pill grammar", () => {
    expect(sanitizePillDisplayLabel("foo [bar] baz")).toBe("foo-bar-baz");
  });

  it("trims surrounding whitespace", () => {
    expect(sanitizePillDisplayLabel("  spaced name ")).toBe("spaced-name");
  });
});

// ============================================================
// serializePillNode — display name must be one round-trippable token
// ============================================================

describe("serializePillNode", () => {
  it("serializes a session pill with a multi-word title as a single token", () => {
    const serialized = serializePillNode({
      filePath: "session://sdeagent-abc-123/1781154320935",
      fileName: "审计 policy 啊permission 那些...",
      iconType: "session",
    });
    expect(serialized).toBe(
      "审计-policy-啊permission-那些... [session:sdeagent-abc-123]"
    );
  });

  it("round-trips through the display-side last-whitespace split", () => {
    const serialized = serializePillNode({
      filePath: "session://sdeagent-abc-123/42",
      fileName: "my long session title",
      iconType: "session",
    });
    // Same split logic as UserMessageContent / pillContentParser: the label
    // is the last whitespace-delimited token before the bracket.
    const match = serialized.match(/^(.*?)\s*\[session:([^\]]+)\]$/);
    expect(match).not.toBeNull();
    const label = match![1].split(/\s/).pop();
    expect(label).toBe("my-long-session-title");
    expect(match![2]).toBe("sdeagent-abc-123");
  });

  it("sanitizes spaced file display names too", () => {
    const serialized = serializePillNode({
      filePath: "/repo/some file.ts",
      fileName: "some file.ts",
      iconType: "file",
    });
    expect(serialized).toBe("some-file.ts [file:/repo/some file.ts]");
  });

  it("serializes browser-inspect DOM component pills with stored paste content", () => {
    window.__orgiiTerminalPillTexts = {
      "paste://inspect-1": '{"cssSelector":"button.primary"}',
    };

    const serialized = serializePillNode({
      filePath: "paste://inspect-1",
      fileName: "Button.json",
      iconType: "dom-component",
    });

    expect(serialized).toMatch(
      /^Button\.json \[dom-component:paste:\/\/inspect-1::/
    );
    expect(serialized).not.toContain("[paste:");
  });

  it("leaves member pills (plain @mention, no bracket grammar) untouched", () => {
    const serialized = serializePillNode({
      filePath: "member-1",
      fileName: "Jane Doe",
      iconType: "member" as never,
    });
    expect(serialized).toBe("@Jane Doe");
  });
});
