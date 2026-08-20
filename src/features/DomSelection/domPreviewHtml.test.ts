// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { sanitizeDomPreviewHtml } from "./domPreviewHtml";

describe("sanitizeDomPreviewHtml", () => {
  it("keeps inert visual styles but removes executable and network content", () => {
    const result = sanitizeDomPreviewHtml(`
      <a href="https://example.test" style="color:red;background:url(https://example.test/a.png)">
        <img src="https://example.test/a.png" onerror="alert(1)" />
        Label
      </a>
      <script>alert(1)</script>
    `);

    expect(result).toContain("color:red");
    expect(result).toContain("Label");
    expect(result).not.toContain("href=");
    expect(result).not.toContain("src=");
    expect(result).not.toContain("onerror");
    expect(result).not.toContain("url(");
    expect(result).not.toContain("script");
  });

  it("returns valid bounded fallback markup", () => {
    const result = sanitizeDomPreviewHtml(
      `<div>${"x".repeat(1_000)}</div>`,
      80
    );
    const host = document.createElement("div");
    host.innerHTML = result;

    expect(result.length).toBeLessThanOrEqual(100);
    expect(host.querySelector("div")).not.toBeNull();
  });
});
