import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import RuntimePanelView from "./RuntimePanelView";

vi.mock("@src/modules/shared/dataSource", () => ({
  default: () => <div data-testid="runtime-sections" />,
}));

vi.mock("../StartPageQuotaGrid", () => ({
  StartPageQuotaGrid: () => null,
}));

vi.mock("./WorkspaceDashboardPanelView", () => ({
  default: () => null,
}));

describe("RuntimePanelView", () => {
  it("contains the absolutely positioned section panel below the chat header", () => {
    const markup = renderToStaticMarkup(<RuntimePanelView />);

    expect(markup).toContain(
      'class="relative flex min-h-0 flex-1 overflow-hidden"'
    );
    expect(markup).toContain('data-testid="runtime-sections"');
  });
});
