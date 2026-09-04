import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { WorkItem } from "@src/types/core/workItem";

import WorkItemRow from ".";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("WorkItemRow", () => {
  it("renders table rows without item separators", () => {
    const workItem = {
      session_id: "work-item-1",
      shortId: "ORG-1",
      name: "Borderless row",
      status: "planned",
      workItemStatus: "planned",
      priority: "none",
      endDate: undefined,
    } as WorkItem;
    const markup = renderToStaticMarkup(
      createElement(WorkItemRow, {
        workItem,
        isSelected: false,
        onSelect: vi.fn(),
        variant: "table",
      })
    );

    const rootClassName = markup.match(
      /data-testid="work-item-row-work-item-1" class="([^"]+)"/
    )?.[1];
    expect(rootClassName).toContain("rounded-none");
    expect(rootClassName?.split(/\s+/)).not.toContain("border-b");
    expect(rootClassName?.split(/\s+/)).not.toContain("border-border-1");
    expect(markup).toContain('type="button"');
    expect(markup).toContain('aria-label="Borderless row"');
  });
});
