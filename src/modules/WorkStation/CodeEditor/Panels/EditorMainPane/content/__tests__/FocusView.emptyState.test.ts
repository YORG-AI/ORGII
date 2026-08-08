import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import FocusView from "../SourceControlMainContent/FocusView";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@src/modules/WorkStation/shared", () => ({
  NoTabsPlaceholder: ({
    caption,
    actions,
  }: {
    caption?: string;
    actions?: unknown[];
  }) =>
    createElement("div", {
      "data-caption": caption,
      "data-action-count": actions?.length ?? 0,
    }),
}));

vi.mock("@src/modules/shared/layouts/blocks", () => ({
  Placeholder: () => null,
}));

describe("FocusView empty state", () => {
  it("asks the user to select a file instead of showing unrelated navigation", () => {
    const markup = renderToStaticMarkup(
      createElement(FocusView, {
        gitFile: null,
        loading: false,
        hasFocus: false,
      })
    );

    expect(markup).toContain(
      'data-caption="placeholders.selectFileToViewChanges"'
    );
    expect(markup).toContain('data-action-count="0"');
  });
});
