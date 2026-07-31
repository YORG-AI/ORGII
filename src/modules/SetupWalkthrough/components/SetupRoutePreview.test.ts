import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import SetupRoutePreview from "./SetupRoutePreview";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("SetupRoutePreview", () => {
  it("renders the organization privacy path for the team goal", () => {
    const markup = renderToStaticMarkup(
      createElement(SetupRoutePreview, {
        goal: "team_activity",
        stepIds: [
          "goal",
          "tools",
          "organization",
          "sharing",
          "basics",
          "tutorial",
          "work-model",
          "ready",
        ],
      })
    );

    expect(markup).toContain('data-route-goal="team_activity"');
    expect(markup).toContain('data-route-step="organization"');
    expect(markup).toContain('data-route-step="sharing"');
    expect(markup).toContain('data-route-destination="team_activity"');
  });

  it("keeps team-only governance out of the personal route", () => {
    const markup = renderToStaticMarkup(
      createElement(SetupRoutePreview, {
        goal: "personal",
        stepIds: ["goal", "tools", "basics", "tutorial", "work-model", "ready"],
      })
    );

    expect(markup).toContain('data-route-goal="personal"');
    expect(markup).not.toContain('data-route-step="organization"');
    expect(markup).not.toContain('data-route-step="sharing"');
  });

  it("keeps a stable route surface before a goal is selected", () => {
    const markup = renderToStaticMarkup(
      createElement(SetupRoutePreview, {
        goal: null,
        stepIds: ["goal", "tools", "basics", "tutorial", "work-model", "ready"],
      })
    );

    expect(markup).toContain('data-route-goal="unselected"');
    expect(markup).toContain('data-route-destination="unselected"');
    expect(markup).toContain('data-route-step="tools"');
  });
});
