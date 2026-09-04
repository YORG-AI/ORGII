import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import RateLimitHintEvent from ".";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      if (key === "chat.rateLimitHintTitle") return "API Rate Limited";
      if (key === "chat.rateLimitHintBody")
        return "Switch windows while waiting";
      return key;
    },
  }),
}));

describe("RateLimitHintEvent", () => {
  it("renders the rate-limit message as a shared warning InlineAlert", () => {
    const markup = renderToStaticMarkup(
      createElement(RateLimitHintEvent, { event_id: "rate-limit-hint" })
    );

    expect(markup).toContain("API Rate Limited");
    expect(markup).toContain("Switch windows while waiting");
    expect(markup).toContain('data-icon="triangle-alert"');
    expect(markup).toContain("rounded-xl");
    expect(markup).toContain("shadow-dropdown-soft");
  });
});
