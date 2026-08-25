import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import FilePathBreadcrumb from ".";

describe("FilePathBreadcrumb", () => {
  const path =
    "/Users/junyu/github/ORGII/src/engines/Simulator/components/RemoteSessionReplayControls.tsx";

  it("wraps between full-path segments without squeezing each segment", () => {
    const markup = renderToStaticMarkup(
      createElement(FilePathBreadcrumb, { path, maxSegments: null })
    );

    expect(markup).toContain("flex-wrap whitespace-normal");
    expect(markup).toContain("shrink-0");
    expect(markup).toContain("break-all");
    expect(markup).toContain("RemoteSessionReplayControls.tsx");
    expect(markup).not.toContain("…");
  });

  it("keeps the compact row variant on one line", () => {
    const markup = renderToStaticMarkup(
      createElement(FilePathBreadcrumb, { path })
    );

    expect(markup).toContain("whitespace-nowrap");
    expect(markup).toContain("…");
    expect(markup).not.toContain("flex-wrap whitespace-normal");
  });
});
