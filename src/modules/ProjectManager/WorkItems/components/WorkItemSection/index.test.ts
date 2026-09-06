import { type ReactNode, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import WorkItemSection from ".";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      key.startsWith("workItems.statusLabels.")
        ? (options?.defaultValue ?? key)
        : key,
  }),
}));

vi.mock("@src/components/Tooltip", () => ({
  default: ({ children }: { children?: ReactNode }) => children,
}));

describe("WorkItemSection", () => {
  it("uses the lighter table background with fill-1 reserved for hover", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkItemSection, {
        statusConfig: {
          value: "planned",
          label: "Planned",
          color: "#86909c",
        },
        label: "Planned",
        count: 3,
        virtualizedHeader: true,
        variant: "table",
      })
    );

    expect(markup).toContain("bg-workstation-bg");
    expect(markup).toContain("hover:bg-fill-1");
    expect(markup).not.toContain("hover:bg-fill-2");
  });

  it("falls back to the definition name for custom statuses instead of the i18n key", () => {
    const markup = renderToStaticMarkup(
      createElement(WorkItemSection, {
        statusConfig: {
          value: "code_review",
          label: "Code Review v2",
          color: "#6366f1",
        },
        count: 0,
      })
    );

    expect(markup).toContain("Code Review v2");
    expect(markup).not.toContain("workItems.statusLabels.code_review");
  });
});
