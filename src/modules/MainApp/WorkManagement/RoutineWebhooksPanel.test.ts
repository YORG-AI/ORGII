import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import RoutineWebhooksPanel, {
  searchPortableRoutines,
} from "./RoutineWebhooksPanel";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("searchPortableRoutines", () => {
  it("uses the shared Work Management list-detail layout", () => {
    const markup = renderToStaticMarkup(
      createElement(RoutineWebhooksPanel, {
        listHeader: createElement("span", {
          "data-testid": "webhook-list-header",
        }),
      })
    );

    expect(markup).toContain('data-layout-mode="split"');
    expect(markup).toContain('data-testid="webhook-list-header"');
    expect(markup).toContain('data-testid="routine-webhooks-compact-list"');
    expect(markup).toContain('data-testid="routine-webhook-detail-pane"');
  });

  it("searches webhook routines by name and stable identifiers", () => {
    const routines = [
      {
        name: "Nightly triage",
        routineId: "routine-42",
        revision: 3,
        enabled: true,
        specHash: "abc123",
        updatedAt: 1,
      },
    ];

    expect(searchPortableRoutines(routines, "nightly")).toEqual(routines);
    expect(searchPortableRoutines(routines, "abc123")).toEqual(routines);
    expect(searchPortableRoutines(routines, "deploy")).toEqual([]);
  });
});
