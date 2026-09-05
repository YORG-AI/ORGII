import { describe, expect, it } from "vitest";

import { IFRAME_STYLE_NONCE } from "@src/util/iframeCspNonce";

import { buildHtmlDocument, buildReactDocument } from "./canvasBuilder";

describe("buildReactDocument", () => {
  it("builds a self-contained React.createElement sandbox without CDN imports", () => {
    const source = `function App() { return React.createElement("div", { className: "ok" }, "Hello"); }`;
    const document = buildReactDocument(source);

    expect(document).toContain("function createElement");
    expect(document).toContain("function appendValue");
    expect(document).toContain("React.createElement");
    expect(document).not.toContain("https://esm.sh");
    expect(document).not.toContain("react-dom");
    expect(document).not.toContain('type="module"');
  });

  it("uses the transient shared scrollbar contract", () => {
    const document = buildReactDocument(
      `function App() { return React.createElement("div", null, "Hello"); }`
    );

    expect(document).toContain("scrollbar-color:transparent transparent");
    expect(document).toContain("[data-scrollbar-scrolling]");
    expect(document).toContain("const hideDelayMs=900");
    expect(document).toContain("{capture:true,passive:true}");
  });

  it("escapes script terminators in agent source", () => {
    const document = buildReactDocument(
      `function App() { return React.createElement("div", null, "</script>"); }`
    );

    expect(document).toContain('const source = "function App()');
    expect(document).toContain("<\\\\/script>");
    expect(document).not.toContain('null, "</script>"');
  });
});

describe("buildHtmlDocument", () => {
  it("injects the transient scrollbar style and observer into full documents", () => {
    const document = buildHtmlDocument(
      '<!doctype html><html><head><style>.app{display:block}</style></head><body><div class="app">Hi</div></body></html>'
    );

    expect(document).toContain("scrollbar-color:transparent transparent");
    expect(document).toContain("[data-scrollbar-scrolling]");
    expect(document).toContain("document.addEventListener('scroll'");
    expect(
      document.match(new RegExp(`nonce="${IFRAME_STYLE_NONCE}"`, "g"))
    ).toHaveLength(3);
  });
});
