import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { COMPOSER_BOTTOM_DOCK_PADDING_CLASS } from "@src/config/composerStackTokens";

import SessionCreatorKanban from ".";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../ChatPanel", async () => {
  const React = await import("react");
  return {
    default: (props: { innerClassName?: string }) =>
      React.createElement("div", {
        "data-inner-class": props.innerClassName,
      }),
  };
});

describe("SessionCreatorKanban", () => {
  it("uses the shared floating-composer bottom edge distance", () => {
    const markup = renderToStaticMarkup(createElement(SessionCreatorKanban));

    expect(markup).toContain(
      `data-inner-class="${COMPOSER_BOTTOM_DOCK_PADDING_CLASS}"`
    );
  });
});
