import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import WorkstationTrailSurface, {
  WorkstationTrailIconButton,
} from "@src/modules/shared/layouts/blocks/WorkstationTrailSurface";

import PropertiesPanel from ".";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("PropertiesPanel", () => {
  it("can hug its property rows inside a floating surface", () => {
    const markup = renderToStaticMarkup(
      createElement(
        WorkstationTrailSurface,
        null,
        createElement(
          PropertiesPanel,
          {
            title: "Project Properties",
            fitContent: true,
            headerVariant: "workstation-trail",
            headerActions: createElement(
              WorkstationTrailIconButton,
              { "aria-label": "Collapse properties" },
              ">>"
            ),
          },
          createElement("span", null, "Status")
        )
      )
    );

    expect(markup).toContain("bg-[var(--cm-editor-background)]");
    expect(markup).toContain("border-border-1");
    expect(markup).toContain("rounded-xl");
    expect(markup).toContain("p-1");
    expect(markup).toContain("shadow-dropdown");
    expect(markup).toContain("mb-1");
    expect(markup).toContain("h-6");
    expect(markup).toContain("h-5 w-5");
    expect(markup).toContain("justify-between pl-1 pr-[3px]");
    expect(markup).toContain("px-1 text-[11px]");
    expect(markup).toContain("max-h-full");
    expect(markup).not.toContain("flex-1 overflow-y-auto");
    expect(markup).toContain("Status");
  });

  it("keeps fill-height behavior as the shared default", () => {
    const markup = renderToStaticMarkup(
      createElement(
        PropertiesPanel,
        {
          title: "Project Properties",
        },
        createElement("span", null, "Status")
      )
    );

    expect(markup).toContain("h-full");
    expect(markup).toContain("flex-1");
  });

  it("places panel controls in the shared 40px title row", () => {
    const markup = renderToStaticMarkup(
      createElement(
        PropertiesPanel,
        {
          title: "Project Properties",
          headerActions: createElement(
            "button",
            { type: "button", "data-testid": "collapse-properties" },
            ">>"
          ),
        },
        createElement("span", null, "Status")
      )
    );

    expect(markup).toContain("h-[40px]");
    expect(markup).toContain("justify-between");
    expect(markup).toContain('data-testid="collapse-properties"');
  });
});
