import { ChevronLeft } from "lucide-react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import SidebarHeaderNavButton from "./SidebarHeaderNavButton";

describe("SidebarHeaderNavButton", () => {
  it("uses the shared 32px sidebar row height", () => {
    const markup = renderToStaticMarkup(
      createElement(SidebarHeaderNavButton, {
        icon: ChevronLeft,
        label: "Work Items",
        onClick: vi.fn(),
      })
    );

    expect(markup).toContain("group mt-1 flex h-8 w-full");
    expect(markup).toContain("items-center gap-3");
    expect(markup).toContain("flex min-w-0 flex-1 flex-col gap-0");
    expect(markup).not.toContain("min-h-[36px]");
  });
});
