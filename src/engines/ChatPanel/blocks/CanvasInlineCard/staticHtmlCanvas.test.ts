import { describe, expect, it } from "vitest";

import { IFRAME_STYLE_NONCE } from "@src/util/iframeCspNonce";

import {
  buildStaticHtmlShadowMarkup,
  extractStaticHtmlBody,
  extractStaticHtmlStyles,
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
