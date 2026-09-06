import { describe, expect, it } from "vitest";

import {
  SessionFollowUpSuggestionsInput,
  SessionFollowUpSuggestionsResponseSchema,
} from "../agentSession";

const suggestions = [
  { label: "Open PR", prompt: "Open the PR.", primary: true },
  { label: "Run checks", prompt: "Run the checks.", primary: false },
  { label: "Review risks", prompt: "Review the risks.", primary: false },
];

describe("session follow-up suggestion schemas", () => {
  it("accepts only three actions with exactly one primary", () => {
    expect(
      SessionFollowUpSuggestionsResponseSchema.safeParse({
        suggestions,
      }).success
    ).toBe(true);
    expect(
      SessionFollowUpSuggestionsResponseSchema.safeParse({
        suggestions: suggestions.map((suggestion) => ({
          ...suggestion,
          primary: true,
        })),
      }).success
    ).toBe(false);
  });

  it("accepts only session context and rejects frontend provider overrides", () => {
    const request = {
      request: {
        sessionId: "session-1",
        messages: [
          { role: "user", content: "Please finish it." },
          { role: "assistant", content: "It is done." },
        ],
      },
    };
    expect(SessionFollowUpSuggestionsInput.safeParse(request).success).toBe(
      true
    );
    expect(
      SessionFollowUpSuggestionsInput.safeParse({
        request: { ...request.request, unexpected: true },
      }).success
    ).toBe(false);
    expect(
      SessionFollowUpSuggestionsInput.safeParse({
        request: { ...request.request, accountId: "another-account" },
      }).success
    ).toBe(false);
  });
});
