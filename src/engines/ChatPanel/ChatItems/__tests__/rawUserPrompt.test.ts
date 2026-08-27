import { describe, expect, it } from "vitest";

import { resolveRawUserPrompt } from "@src/engines/ChatPanel/ChatItems/rawUserPrompt";
import { makeSessionEvent } from "@src/engines/SessionCore/rendering/props/__tests__/fixtures";

const PILL_EXPANSION =
  "\n\n---\n**Referenced content (auto-expanded):**\n\n# Setup Repo Skill\n\nDo stuff.";

function userEvent(
  overrides: Parameters<typeof makeSessionEvent>[0] = {}
): ReturnType<typeof makeSessionEvent> {
  return makeSessionEvent({
    source: "user",
    actionType: "raw",
    functionName: "user_message",
    displayVariant: "message",
    ...overrides,
  });
}

describe("resolveRawUserPrompt", () => {
  it("returns the wire content, not the pill-format display text", () => {
    const wire = `setup-repo [skill:/setup-repo]${PILL_EXPANSION}`;
    const event = userEvent({
      displayText: "setup-repo [skill:/setup-repo]",
      result: { type: "user", message: { role: "user", content: wire } },
    });

    expect(resolveRawUserPrompt(event)).toBe(wire);
  });

  it("keeps the auto-expanded reference block the bubble strips", () => {
    const wire = `look at this${PILL_EXPANSION}`;
    const event = userEvent({
      displayText: wire,
      result: { type: "user", message: { role: "user", content: wire } },
    });

    expect(resolveRawUserPrompt(event)).toContain(
      "Referenced content (auto-expanded)"
    );
  });

  it("keeps the external-CLI envelope the bubble normalizes away", () => {
    const wire = [
      "## Files mentioned by the user:",
      "### main.ts: /repo/main.ts",
      "## My request for Codex:",
      "explain this",
    ].join("\n");
    const event = userEvent({
      result: { type: "user", message: { role: "user", content: wire } },
    });

    expect(resolveRawUserPrompt(event)).toBe(wire);
  });

  it("falls back to displayText for legacy events with no wire content", () => {
    const event = userEvent({ displayText: "legacy prompt", result: {} });

    expect(resolveRawUserPrompt(event)).toBe("legacy prompt");
  });

  it("returns an empty string for a null message content", () => {
    const event = userEvent({
      displayText: "",
      result: { type: "user", message: { role: "user", content: null } },
    });

    expect(resolveRawUserPrompt(event)).toBe("");
  });

  it("returns an empty string when there is no event", () => {
    expect(resolveRawUserPrompt(undefined)).toBe("");
  });
});
