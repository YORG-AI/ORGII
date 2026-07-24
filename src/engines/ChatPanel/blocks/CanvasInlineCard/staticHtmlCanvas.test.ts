import { describe, expect, it } from "vitest";

import { IFRAME_STYLE_NONCE } from "@src/util/iframeCspNonce";

import {
  buildStaticHtmlShadowMarkup,
  extractStaticHtmlBody,
  extractStaticHtmlStyles,
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
});
