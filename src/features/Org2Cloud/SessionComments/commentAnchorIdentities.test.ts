import { describe, expect, it } from "vitest";

import {
  areCommentAnchorIdentitiesEqual,
  toCommentAnchorIdentities,
} from "./commentAnchorIdentities";

describe("toCommentAnchorIdentities", () => {
  it("returns the shared empty list when there are no events", () => {
    const empty = toCommentAnchorIdentities([]);
    expect(empty).toEqual([]);
    expect(toCommentAnchorIdentities([])).toBe(empty);
  });

  it("keeps only id and source", () => {
    expect(
      toCommentAnchorIdentities([
        { id: "user-1", source: "user", displayText: "hello" },
        { id: "asst-1", source: "assistant", displayText: "token" },
      ])
    ).toEqual([
      { id: "user-1", source: "user" },
      { id: "asst-1", source: "assistant" },
    ]);
  });
});

describe("areCommentAnchorIdentitiesEqual", () => {
  it("treats token-only displayText churn as equal when identities match", () => {
    const previous = toCommentAnchorIdentities([
      { id: "user-1", source: "user" },
      { id: "asst-1", source: "assistant", displayText: "Hel" },
    ]);
    const next = toCommentAnchorIdentities([
      { id: "user-1", source: "user" },
      { id: "asst-1", source: "assistant", displayText: "Hello world" },
    ]);

    expect(areCommentAnchorIdentitiesEqual(previous, next)).toBe(true);
  });

  it("detects a new event, source change, and empty input", () => {
    const previous = toCommentAnchorIdentities([
      { id: "user-1", source: "user" },
    ]);

    expect(
      areCommentAnchorIdentitiesEqual(
        previous,
        toCommentAnchorIdentities([
          { id: "user-1", source: "user" },
          { id: "asst-1", source: "assistant" },
        ])
      )
    ).toBe(false);
    expect(
      areCommentAnchorIdentitiesEqual(
        previous,
        toCommentAnchorIdentities([{ id: "user-1", source: "assistant" }])
      )
    ).toBe(false);
    expect(areCommentAnchorIdentitiesEqual(previous, [])).toBe(false);
    expect(areCommentAnchorIdentitiesEqual([], [])).toBe(true);
  });

  it("is referentially equal for the same array", () => {
    const identities = toCommentAnchorIdentities([
      { id: "user-1", source: "user" },
    ]);
    expect(areCommentAnchorIdentitiesEqual(identities, identities)).toBe(true);
  });
});
