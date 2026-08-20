import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import ScheduleEditor from ".";

vi.mock("@src/components/Select", () => ({
  default: ({
    selectorClassName,
    size,
  }: {
    selectorClassName?: string;
    size?: string;
  }) =>
    createElement("div", {
      "data-selector-class": selectorClassName,
      "data-size": size,
    }),
}));

vi.mock("@src/components/TimePicker", () => ({
  default: () => createElement("div"),
}));

vi.mock("../WorkItemProperties/DateQuickAssignDropdown", () => ({
  DateQuickAssignDropdown: () => createElement("div"),
}));

describe("ScheduleEditor", () => {
  it("uses Workstation trail section insets in compact mode", () => {
    const markup = renderToStaticMarkup(
      createElement(ScheduleEditor, {
        schedule: null,
        onChange: vi.fn(),
        t: (key: string) => key,
        compact: true,
      })
    );

    expect(markup).toContain("space-y-3");
    expect(markup).toContain("space-y-1");
    expect(markup).toContain("px-2 text-left text-[11px]");
    expect(markup).toContain("uppercase tracking-wide");
    expect(markup).toContain('data-selector-class="!px-2 !text-[12px]"');
    expect(markup).toContain('data-size="small"');
    expect(markup).not.toContain("p-2");
    expect(markup).not.toContain("p-3");
  });
});
