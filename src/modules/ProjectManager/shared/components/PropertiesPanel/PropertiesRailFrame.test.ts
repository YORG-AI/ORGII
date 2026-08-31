import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { WORKSTATION_TRAIL_RAIL_PADDING_CLASS } from "@src/modules/shared/layouts/blocks/WorkstationTrailSurface";

import PropertiesRailFrame from "./PropertiesRailFrame";

describe("PropertiesRailFrame", () => {
  it("defaults floating content to the expanded Workstation trail width", () => {
    const markup = renderToStaticMarkup(
      createElement(
        PropertiesRailFrame,
        { floatingContent: true },
        createElement("span", null, "Properties")
      )
    );

    expect(markup).toContain("width:256px");
  });

  it("uses the exact Workstation trail spacing for floating content", () => {
    const markup = renderToStaticMarkup(
      createElement(
        PropertiesRailFrame,
        { floatingContent: true, width: 300 },
        createElement("span", null, "Properties")
      )
    );

    for (const className of WORKSTATION_TRAIL_RAIL_PADDING_CLASS.split(" ")) {
      expect(markup).toContain(className);
    }
    expect(markup).not.toContain("p-2");
    expect(markup).toContain("width:300px");
  });
});
