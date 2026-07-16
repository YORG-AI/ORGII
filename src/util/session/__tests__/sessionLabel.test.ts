import { vi } from "vitest";

import { sessionLabel } from "../sessionLabel";

vi.mock("@src/features/SessionCreator/config", () => ({
  SESSION_CONFIG: { DEFAULT_SESSION_NAME: "New Session" },
}));

describe("sessionLabel", () => {
  it("uses name when provided and not default session name", () => {
    expect(sessionLabel({ name: "My Feature" })).toBe("My Feature");
  });

  it("falls back to user_input when name is default", () => {
    expect(
      sessionLabel({ name: "New Session", user_input: "Fix the bug in auth" })
    ).toBe("Fix the bug in auth");
  });

  it("prefers backend displayLabel before user_input for default names", () => {
    expect(
      sessionLabel({
        name: "New Session",
        displayLabel: "External app title",
        user_input: "Fix the bug in auth",
      })
    ).toBe("External app title");
  });

  it("falls back to user_input when name is undefined", () => {
    expect(sessionLabel({ user_input: "Refactor store" })).toBe(
      "Refactor store"
    );
  });

  it('falls back to "Untitled" when both are empty', () => {
    expect(sessionLabel({})).toBe("Untitled");
    expect(sessionLabel({ name: "", user_input: "" })).toBe("Untitled");
  });

  it("truncates to maxLength (default 30)", () => {
    const longName = "abcdefghijklmnopqrstuvwxyz0123456789";
    expect(sessionLabel({ name: longName })).toBe(
      "abcdefghijklmnopqrstuvwxyz0123"
    );
    expect(sessionLabel({ name: longName }, 10)).toBe("abcdefghij");
  });

  it("strips pill references from input", () => {
    expect(
      sessionLabel({
        name: "Title [file:src/foo.ts] rest",
      })
    ).toBe("Title rest");
  });
});
