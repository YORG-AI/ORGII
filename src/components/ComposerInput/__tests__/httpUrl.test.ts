import { describe, expect, it } from "vitest";

import { parseHttpUrlPill } from "../httpUrl";

describe("parseHttpUrlPill", () => {
  it("accepts a standalone HTTPS URL and trims clipboard whitespace", () => {
    expect(
      parseHttpUrlPill(
        "  https://example.com/docs/getting-started?view=full#install\n"
      )
    ).toEqual({
      url: "https://example.com/docs/getting-started?view=full#install",
      displayName: "example.com/docs/getting-started?view=full#install",
    });
  });

  it.each([
    ["http://localhost:3000/docs", "localhost:3000/docs"],
    ["http://127.0.0.1:5173/", "127.0.0.1:5173"],
  ])("accepts development URL %s", (value, displayName) => {
    expect(parseHttpUrlPill(value)).toEqual({ url: value, displayName });
  });

  it.each([
    "see https://example.com next",
    "example.com/docs",
    "ftp://example.com/file",
    "https://intranet",
    "https://user:secret@example.com/private",
    "https://example.com/docs/[draft]",
    "http://[::1]:8080/health",
    "not a url",
  ])("rejects non-standalone or unsafe candidate %s", (candidate) => {
    expect(parseHttpUrlPill(candidate)).toBeNull();
  });
});
