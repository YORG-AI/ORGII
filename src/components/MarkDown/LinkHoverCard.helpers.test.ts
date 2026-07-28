import { describe, expect, it } from "vitest";

import { getHttpLinkPreview } from "./LinkHoverCard.helpers";

describe("getHttpLinkPreview", () => {
  it("builds a compact preview for HTTPS links", () => {
    expect(
      getHttpLinkPreview("https://www.example.com/docs/start?q=codex")
    ).toEqual({
      url: "https://www.example.com/docs/start?q=codex",
      host: "example.com",
      displayUrl: "www.example.com/docs/start?q=codex",
    });
  });

  it("preserves local development hosts and ports", () => {
    expect(getHttpLinkPreview("http://localhost:1998")).toEqual({
      url: "http://localhost:1998/",
      host: "localhost:1998",
      displayUrl: "localhost:1998",
    });
  });

  it("does not create hover previews for non-web protocols", () => {
    expect(getHttpLinkPreview("mailto:hello@example.com")).toBeNull();
    expect(getHttpLinkPreview("file:///tmp/report.html")).toBeNull();
    expect(getHttpLinkPreview("javascript:alert(1)")).toBeNull();
  });

  it("does not create hover previews for template placeholders", () => {
    expect(getHttpLinkPreview("http://${host}:${port}/docs")).toBeNull();
  });
});
