import { type ReactNode, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import LaunchButton from "./LaunchButton";

vi.mock("@src/components/Tooltip", () => ({
  default: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("LaunchButton", () => {
  it("keeps the round icon treatment with a custom submit name", () => {
    const markup = renderToStaticMarkup(
      createElement(LaunchButton, {
        ariaLabel: "Save work item",
        disabled: false,
        loading: false,
        onClick: vi.fn(),
      })
    );

    expect(markup).toContain('aria-label="Save work item"');
    expect(markup).toContain("rounded-full");
    expect(markup).toContain("<svg");
    expect(markup).not.toContain(">Save work item</span>");
  });
});
