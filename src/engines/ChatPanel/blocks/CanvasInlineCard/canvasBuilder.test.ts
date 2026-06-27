import { describe, expect, it } from "vitest";

import { buildReactDocument } from "./canvasBuilder";

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

  it("escapes script terminators in agent source", () => {
    const document = buildReactDocument(
      `function App() { return React.createElement("div", null, "</script>"); }`
    );

    expect(document).toContain('const source = "function App()');
    expect(document).toContain("<\\\\/script>");
    expect(document).not.toContain('null, "</script>"');
  });
});
