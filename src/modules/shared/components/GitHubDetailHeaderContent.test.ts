import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import GitHubDetailHeaderContent from "./GitHubDetailHeaderContent";

const mocks = vi.hoisted(() => ({
  integrationIconProps: null as Record<string, unknown> | null,
}));

vi.mock("@src/components/IntegrationIcon", () => ({
  default: (props: Record<string, unknown>) => {
    mocks.integrationIconProps = props;
    return createElement("span", { "data-testid": "github-icon" });
  },
}));

describe("GitHubDetailHeaderContent", () => {
  it("keeps identity chrome fixed while the title owns truncation", () => {
    const title = "A long GitHub title that should use the available width";
    const markup = renderToStaticMarkup(
      createElement(GitHubDetailHeaderContent, {
        number: 68,
        title,
        status: createElement("span", { "data-testid": "status" }, "Open"),
      })
    );

    expect(mocks.integrationIconProps).toMatchObject({
      type: "github",
      size: 14,
      className: "shrink-0",
    });
    expect(markup).toContain("flex min-w-0 flex-1 items-center gap-2");
    expect(markup).toContain("shrink-0 select-text text-[11px]");
    expect(markup).toContain("min-w-0 flex-1 select-text truncate");
    expect(markup).toContain(`title="${title}"`);
    expect(markup.indexOf("Open")).toBeLessThan(markup.indexOf("#68"));
    expect(markup.indexOf("#68")).toBeLessThan(markup.indexOf(title));
  });
});
