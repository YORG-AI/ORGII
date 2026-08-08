// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { IFRAME_STYLE_NONCE } from "@src/util/iframeCspNonce";

import {
  buildStaticHtmlShadowMarkup,
  extractStaticHtmlBody,
  extractStaticHtmlStyles,
  sanitizeStaticHtmlBody,
  sanitizeStaticHtmlStyles,
} from "./staticHtmlCanvas";

describe("static HTML canvas", () => {
  it("extracts styles separately from a full HTML document", () => {
    const content = `<!doctype html><html><head><style>.app{display:grid;background:red}</style></head><body><div class="app">Styled</div></body></html>`;

    expect(extractStaticHtmlStyles(content)).toBe(
      ".app{display:grid;background:red}"
    );
    expect(extractStaticHtmlBody(content)).toBe(
      '<div class="app">Styled</div>'
    );
  });

  it("keeps inline presentation while removing executable HTML", () => {
    const body = sanitizeStaticHtmlBody(`
      <div style="display:grid;background:#111" onclick="window.pwned=true">
        Styled
        <script>window.pwned=true</script>
      </div>
    `);

    expect(body).toContain('style="display:grid;background:#111"');
    expect(body).not.toContain("onclick");
    expect(body).not.toContain("<script");
  });

  it("removes network-capable attributes and unsafe inline CSS", () => {
    const body = sanitizeStaticHtmlBody(`
      <a href="https://example.com/track">Remote</a>
      <img src="https://example.com/pixel.png" srcset="https://example.com/2x.png 2x">
      <div style="background:url(https://example.com/pixel);color:red">Styled</div>
    `);

    expect(body).not.toContain("https://example.com");
    expect(body).not.toContain("srcset");
    expect(body).not.toContain("style=");
  });

  it("keeps local fragments and bounded raster data images", () => {
    const body = sanitizeStaticHtmlBody(`
      <a href="#details">Details</a>
      <img src="data:image/png;base64,iVBORw0KGgo=">
    `);

    expect(body).toContain('href="#details"');
    expect(body).toContain('src="data:image/png;base64,iVBORw0KGgo="');
  });

  it("nonces every Shadow DOM style block for the Tauri WebKit CSP", () => {
    const markup = buildStaticHtmlShadowMarkup(
      '<div class="app">Styled</div>',
      ".app{display:grid;background:red}"
    );
    const styleTags = markup.match(/<style\b[^>]*>/g) ?? [];

    expect(styleTags).toHaveLength(3);
    for (const styleTag of styleTags) {
      expect(styleTag).toContain(`nonce="${IFRAME_STYLE_NONCE}"`);
    }
    expect(markup).toContain(".app{display:grid;background:red}");
    expect(markup).toContain('<div class="app">Styled</div>');
  });

  it("neutralizes style terminators before building Shadow DOM markup", () => {
    const styles = extractStaticHtmlStyles(
      "<style>.safe{}<\\/style>.also-safe{}</style>"
    );
    const markup = buildStaticHtmlShadowMarkup("<div>Safe</div>", styles);

    expect(markup.match(/<style\b[^>]*>/g)).toHaveLength(3);
    expect(markup).not.toMatch(/<\/style[^>]*>\.also-safe/);
  });

  it.each([
    '@import url("https://example.com/theme.css");',
    ".leak{background:url(https://example.com/pixel)}",
    ":host{position:absolute}",
    ":host-context(.dark){color:white}",
    ".overlay{position:fixed;inset:0}",
    ".overlay{pos/**/ition:fixed;inset:0}",
    ".toolbar{position: sticky;top:0}",
    ".\\68 ost{position:absolute}",
  ])("rejects CSS that can cross the Shadow DOM boundary: %s", (styles) => {
    expect(sanitizeStaticHtmlStyles(styles)).toBe("");
  });

  it("keeps ordinary scoped presentation CSS", () => {
    expect(
      sanitizeStaticHtmlStyles(
        ".app{display:grid;background:red}@media(min-width:600px){.app{gap:1rem}}"
      )
    ).toContain("display:grid");
  });

  it("pins critical containment on the wrapper with important inline styles", () => {
    const markup = buildStaticHtmlShadowMarkup("<div>Safe</div>", "");

    expect(markup).toContain("contain:layout paint style!important");
    expect(markup).toContain("overflow:auto!important");
  });
});
