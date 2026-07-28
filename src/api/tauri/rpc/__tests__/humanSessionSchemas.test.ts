import { describe, expect, it } from "vitest";

import {
  HUMAN_SESSION_TITLE_MAX_LENGTH,
  HumanSessionAppendInput,
  HumanSessionCreateInput,
} from "../schemas/humanSession";

describe("Human-session RPC schemas", () => {
  it("accepts an optional title with one initial note", () => {
    expect(
      HumanSessionCreateInput.parse({
        request: {
          body: "Shipped the review flow",
          title: "Review flow evidence",
          workspacePath: null,
        },
      }).request
    ).toEqual({
      body: "Shipped the review flow",
      title: "Review flow evidence",
      workspacePath: null,
    });
  });

  it("accepts a missing title", () => {
    expect(
      HumanSessionCreateInput.parse({
        request: { body: "Use this note as the title" },
      }).request.title
    ).toBeUndefined();
  });

  it("rejects titles over the persisted limit", () => {
    expect(() =>
      HumanSessionCreateInput.parse({
        request: {
          body: "Initial note",
          title: "x".repeat(HUMAN_SESSION_TITLE_MAX_LENGTH + 1),
        },
      })
    ).toThrow();
  });

  it("rejects empty appended notes", () => {
    expect(() =>
      HumanSessionAppendInput.parse({
        request: { sessionId: "humansession-1", body: "   " },
      })
    ).toThrow();
  });
});
