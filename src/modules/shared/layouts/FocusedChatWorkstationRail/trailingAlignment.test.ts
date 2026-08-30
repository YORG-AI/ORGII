import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FolderClosedIcon } from "@src/icons";

import { WorkspaceContextRow } from "./WorkspaceContextRow";
import { WorkstationItemRow } from "./WorkstationItemRow";

describe("focused-chat Workstation trail trailing alignment", () => {
  it("uses the shared trailing inset and 14px box for branch chevrons", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkspaceContextRow, {
        chevron: true,
        icon: FolderClosedIcon,
        label: "develop",
      })
    );

    expect(markup).toContain("pl-2 pr-1.5");
    expect(markup).toContain('data-icon="chevron-down"');
    expect(markup).toContain('width="14"');
    expect(markup).toContain('height="14"');
  });

  it("uses the same trailing inset and box for external-link arrows", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkstationItemRow, {
        item: {
          key: "compare-branch",
          label: "Compare branch",
          icon: FolderClosedIcon,
          external: true,
          onClick: () => {},
        },
      })
    );

    expect(markup).toContain("pl-2 pr-1.5");
    expect(markup).toContain('data-icon="arrow-up-right"');
    expect(markup).toContain('width="14"');
    expect(markup).toContain('height="14"');
  });
});
