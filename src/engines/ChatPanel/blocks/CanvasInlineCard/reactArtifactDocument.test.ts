import { describe, expect, it } from "vitest";

import {
  REACT_ARTIFACT_FRAME_CSP,
  buildReactArtifactDocument,
  normalizeReactArtifactSource,
} from "./reactArtifactDocument";

describe("normalizeReactArtifactSource", () => {
  it("converts a default App function export into a render call", () => {
    const source = normalizeReactArtifactSource(
      "export default function App() { return <button>Hi</button>; }"
    );

    expect(source).toContain("function App()");
    expect(source).not.toContain("export default");
    expect(source).toContain("render(<App />);");
  });

  it("names anonymous default function exports App", () => {
    const source = normalizeReactArtifactSource(
      "export default function () { return <div>Hi</div>; }"
    );

    expect(source).toContain("function App(");
    expect(source).toContain("render(<App />);");
  });

  it("renders a named default export under its own name", () => {
    const source = normalizeReactArtifactSource(
      "function Dashboard() { return <div>Hi</div>; }\nexport default Dashboard;"
    );

    expect(source).not.toContain("export default");
    expect(source).toContain("render(<Dashboard />);");
  });

  it("binds default-exported expressions to App", () => {
    const source = normalizeReactArtifactSource(
      "export default () => <div>Hi</div>;"
    );

    expect(source).toContain("const App = () => <div>Hi</div>;");
    expect(source).toContain("render(<App />);");
  });

  it("strips react imports since React is a UMD global in the document", () => {
    const source = normalizeReactArtifactSource(
      [
        'import React, { useState } from "react";',
        'import { useEffect } from "react";',
        "export default function App() { return <div />; }",
      ].join("\n")
    );

    expect(source).not.toContain('from "react"');
    expect(source).toContain("render(<App />);");
  });

  it("appends a render call for declared App components without exports", () => {
    const source = normalizeReactArtifactSource(
      "function App() { return <div>Hi</div>; }"
    );

    expect(source).toContain("render(<App />);");
  });

  it("passes bare expression snippets through unchanged", () => {
    expect(normalizeReactArtifactSource("<button>Hello</button>")).toBe(
      "<button>Hello</button>"
    );
  });
});

describe("buildReactArtifactDocument", () => {
  const validSource = "export default function App() { return <div>Hi</div>; }";

  it("embeds the strict frame CSP as a meta tag", () => {
    const documentHtml = buildReactArtifactDocument(validSource);

    expect(documentHtml).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${REACT_ARTIFACT_FRAME_CSP}">`
    );
    expect(REACT_ARTIFACT_FRAME_CSP).toContain("connect-src 'none'");
    expect(REACT_ARTIFACT_FRAME_CSP).toContain("default-src 'none'");
  });

  it("inlines the React runtimes and the compiled artifact", () => {
    const documentHtml = buildReactArtifactDocument(validSource);

    // React + ReactDOM UMD globals must exist before the artifact script.
    expect(documentHtml).toContain("ReactDOM.createRoot");
    expect(documentHtml).toContain("function App()");
    // JSX is compiled to classic createElement calls against the UMD global.
    expect(documentHtml).toContain("React.createElement");
    expect(documentHtml).toContain('<div id="root">');
    expect(documentHtml).toContain("unhandledrejection");
  });

  it("escapes </script> sequences so artifact strings cannot break out", () => {
    const documentHtml = buildReactArtifactDocument(
      'export default function App() { return <div>{"</script><script>alert(1)</script>"}</div>; }'
    );

    expect(documentHtml).not.toContain("</script><script>alert(1)");
    expect(documentHtml).toContain("<\\/script>");
  });

  it("throws on uncompilable source so callers can surface a compile error", () => {
    expect(() => buildReactArtifactDocument("function App( {")).toThrow();
  });
});
