import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { StartPageQuotaModal } from "./StartPageQuotaModal";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@src/scaffold/ModalSystem", () => ({
  default: ({
    children,
    headerActions,
    title,
    visible,
    width,
  }: {
    children: React.ReactNode;
    headerActions: React.ReactNode;
    title: React.ReactNode;
    visible: boolean;
    width: number;
  }) =>
    visible
      ? createElement(
          "section",
          { "data-testid": "quota-modal", "data-width": width },
          title,
          headerActions,
          children
        )
      : null,
}));
vi.mock("./StartPageQuotaGrid", () => ({
  StartPageQuotaGrid: ({ showHeader }: { showHeader: boolean }) =>
    createElement("div", {
      "data-testid": "runtime-quota-grid",
      "data-show-header": String(showHeader),
    }),
}));

describe("StartPageQuotaModal", () => {
  it("puts icon-only refresh ahead of close while reusing the Runtime quota grid", () => {
    const markup = renderToStaticMarkup(
      createElement(StartPageQuotaModal, {
        visible: true,
        onClose: vi.fn(),
      })
    );

    expect(markup).toContain('data-testid="quota-modal"');
    expect(markup).toContain('data-width="760"');
    expect(markup).toContain("kanban.dataSource.views.quota");
    expect(markup).toContain('data-testid="quota-modal-refresh"');
    expect(markup).toContain('data-show-header="false"');
    expect(markup).toContain('data-testid="runtime-quota-grid"');
    expect(markup.indexOf("quota-modal-refresh")).toBeLessThan(
      markup.indexOf("runtime-quota-grid")
    );
  });
});
