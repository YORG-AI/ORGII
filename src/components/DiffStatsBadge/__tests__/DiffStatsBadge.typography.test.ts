import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import DiffStatsBadge from "..";

describe("DiffStatsBadge typography", () => {
  it("preserves medium weight by default", () => {
    const markup = renderToStaticMarkup(
      createElement(DiffStatsBadge, { additions: 12, deletions: 3 })
    );

    expect(markup).toContain("font-medium");
    expect(markup).not.toContain("font-normal");
  });

  it("supports a semantic normal-weight status-bar variant", () => {
    const markup = renderToStaticMarkup(
      createElement(DiffStatsBadge, {
        additions: 12,
        deletions: 3,
        variant: "plain",
        size: "xs",
        weight: "normal",
      })
    );

    expect(markup).toContain("text-[11px]");
    expect(markup).toContain("font-mono");
    expect(markup).toContain("font-normal");
    expect(markup).toContain("tabular-nums");
    expect(markup).not.toContain("font-medium");
  });
});
