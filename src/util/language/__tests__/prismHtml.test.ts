import { describe, expect, it } from "vitest";

import {
  escapeHtml,
  highlightToHtml,
  isPrismLanguage,
  resolvePrismLanguage,
} from "../prismHtml";

describe("prismHtml", () => {
  it("emits Prism token spans with class names and no inline styles", () => {
    const html = highlightToHtml("const x = 1;", "typescript");
    expect(html).not.toBeNull();
    expect(html).toContain('<span class="token keyword">const</span>');
    expect(html).toContain('<span class="token number">1</span>');
    expect(html).not.toContain("style=");
    expect(html).not.toContain("<pre");
  });

  it("escapes HTML in text and keeps markup out of the output", () => {
    const html = highlightToHtml(
      'echo "<script>alert(1)</script>" && x',
      "bash"
    );
    expect(html).not.toBeNull();
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;&amp;");
  });

  it("returns null for languages without a registered grammar", () => {
    expect(highlightToHtml("anything", "no-such-language")).toBeNull();
    expect(highlightToHtml("anything", undefined)).toBeNull();
    expect(highlightToHtml("anything", "")).toBeNull();
  });

  it("resolves the editor / legacy-highlighter names to Prism grammars", () => {
    expect(resolvePrismLanguage("shellscript")).toBe("bash");
    expect(resolvePrismLanguage("typescriptreact")).toBe("tsx");
    expect(resolvePrismLanguage("javascriptreact")).toBe("jsx");
    expect(resolvePrismLanguage("dockerfile")).toBe("docker");
    expect(resolvePrismLanguage("ts")).toBe("typescript");
    expect(resolvePrismLanguage("html")).toBe("html");
    expect(resolvePrismLanguage("  Python ")).toBe("python");
    expect(resolvePrismLanguage("log")).toBe("log");
    expect(isPrismLanguage("no-such-language")).toBe(false);
  });

  it("treats Prism's built-in plain-text names as token-free passthrough", () => {
    // Prism core registers plain/plaintext/text as empty grammars.
    expect(highlightToHtml("a < b", "plaintext")).toBe("a &lt; b");
  });

  it("escapeHtml covers the five HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;"
    );
  });
});
