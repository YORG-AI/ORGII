import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import TabPill from ".";

function getButtonTag(markup: string, testId: string): string {
  const match = markup.match(
    new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`)
  );

  expect(match).not.toBeNull();
  return match?.[0] ?? "";
}

describe("TabPill", () => {
  it("paints pill selection and hover states on each button without a measured overlay", () => {
    const markup = renderToStaticMarkup(
      createElement(TabPill, {
        variant: "pill",
        appearance: "ghost",
        activeTab: "list",
        tabs: [
          { key: "list", label: "List", dataTestId: "list-tab" },
          { key: "board", label: "Board", dataTestId: "board-tab" },
        ],
      })
    );

    expect(getButtonTag(markup, "list-tab")).toContain("bg-surface-hover");
    expect(getButtonTag(markup, "board-tab")).toContain(
      "hover:bg-surface-hover"
    );
    expect(markup).not.toContain("data-seg");
    expect(markup).not.toContain("translateX(");
  });
});
