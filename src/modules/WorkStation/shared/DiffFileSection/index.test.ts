import { Provider } from "jotai";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import DiffFileSection from ".";

vi.mock("@src/components/FileTypeIcon", () => ({
  default: () => React.createElement("span", { "data-file-icon": true }),
}));

const FILE = {
  path: "src/index.tsx",
  status: "modified" as const,
  staged: false,
};

function renderSection(compactHeaderGutter = false) {
  return renderToStaticMarkup(
    React.createElement(
      Provider,
      null,
      React.createElement(DiffFileSection, {
        file: FILE,
        viewMode: "unified",
        defaultExpanded: false,
        compactHeaderGutter,
      })
    )
  );
}

describe("DiffFileSection header gutter", () => {
  it("keeps the shared gutter by default", () => {
    const markup = renderSection();

    expect(markup).toContain("px-3");
    expect(markup).not.toContain("px-2");
  });

  it("supports the compact Source Control gutter", () => {
    const markup = renderSection(true);

    expect(markup).toContain("px-2");
    expect(markup).not.toContain("px-3");
  });
});
