import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { IssueTimelineItems } from "../IssueTimelineItems";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string; reason?: string }) =>
      options?.reason
        ? `Unable to load activity: ${options.reason}`
        : (options?.defaultValue ?? ""),
  }),
}));

describe("IssueTimelineItems", () => {
  it("yields to the host alert instead of burying the failure in the thread", () => {
    // The reason a thread is empty belongs above the title, not at the end of
    // the activity list where it reads as just another event.
    const markup = renderToStaticMarkup(
      React.createElement(IssueTimelineItems, {
        timeline: [],
        timelineLoading: false,
        timelineError: "github_rate_limited",
      })
    );

    expect(markup).toBe("");
  });

  it("still shows the loading state while the request is running", () => {
    const markup = renderToStaticMarkup(
      React.createElement(IssueTimelineItems, {
        timeline: [],
        timelineLoading: true,
        timelineError: "github_rate_limited",
      })
    );

    expect(markup).not.toBe("");
  });
});
