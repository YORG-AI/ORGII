// @vitest-environment jsdom
import { type ReactNode, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import DetailPaneLayout, { DetailPanePlaceholder } from "./DetailPaneLayout";

vi.mock("@src/components/Placeholder", () => ({
  Placeholder: ({
    variant,
    placement,
    fillParentHeight,
  }: {
    variant: string;
    placement?: string;
    fillParentHeight?: boolean;
  }) =>
    createElement("div", {
      "data-placeholder-variant": variant,
      "data-placeholder-placement": placement,
      "data-fill-parent-height": String(fillParentHeight),
    }),
}));

vi.mock("@src/modules/shared/components/DetailHeaderIconAction", () => ({
  default: ({
    label,
    icon,
    testId,
  }: {
    label: string;
    icon: ReactNode;
    testId?: string;
  }) =>
    createElement(
      "button",
      { type: "button", "aria-label": label, "data-testid": testId },
      icon
    ),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("DetailPaneLayout", () => {
  it("owns the shared right-pane header and full-height body", () => {
    const markup = renderToStaticMarkup(
      createElement(
        DetailPaneLayout,
        {
          header: {
            children: createElement("span", null, "Issue #42"),
            actions: createElement("button", { type: "button" }, "Close"),
          },
          testId: "detail-pane",
        },
        createElement("main", null, "Detail body")
      )
    );

    expect(markup).toContain('data-testid="detail-pane"');
    expect(markup).toContain('data-detail-pane-layout="true"');
    expect(markup).toContain("Issue #42");
    expect(markup).toContain("Close");
    expect(markup).toContain("Detail body");
    expect(markup).toContain("border-b");
    expect(markup).toContain("pl-4!");
    expect(markup).toContain("pr-[7px]!");
    expect(markup).toContain("data-detail-pane-body");
  });

  it("pins placeholders to the detail body placement", () => {
    const markup = renderToStaticMarkup(
      createElement(DetailPanePlaceholder, { variant: "loading" })
    );

    expect(markup).toContain('data-placeholder-variant="loading"');
    expect(markup).toContain('data-placeholder-placement="detail-panel"');
    expect(markup).toContain('data-fill-parent-height="true"');
  });

  it("keeps a close action in an otherwise empty detail header", () => {
    const markup = renderToStaticMarkup(
      createElement(
        DetailPaneLayout,
        {
          onClose: vi.fn(),
          closeLabel: "Close detail",
          closeTestId: "close-detail",
        },
        createElement(DetailPanePlaceholder, { variant: "empty" })
      )
    );

    expect(markup).toContain('data-testid="close-detail"');
    expect(markup).toContain('aria-label="Close detail"');
    expect(markup).toContain('data-icon="x"');
    expect(markup).toContain("border-b");
  });
});
