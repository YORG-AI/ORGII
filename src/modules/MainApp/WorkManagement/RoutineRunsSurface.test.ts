import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import RoutineRunsSurface, { searchRoutineRuns } from "./RoutineRunsSurface";
import { WorkManagementSplitHeaderContext } from "./workManagementSplitHeaderContext";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@src/hooks/navigation", () => ({
  useRoutineResultNavigation: () => vi.fn(),
}));

describe("RoutineRunsSurface", () => {
  it("uses the shared Work Management list-detail layout", () => {
    const markup = renderToStaticMarkup(
      createElement(
        WorkManagementSplitHeaderContext.Provider,
        {
          value: {
            splitDatasetControl: createElement("span", {
              "data-testid": "split-dataset-control",
            }),
            surfaceDatasetControl: createElement("span", {
              "data-testid": "surface-dataset-control",
            }),
          },
        },
        createElement(RoutineRunsSurface)
      )
    );

    expect(markup).toContain('data-layout-mode="split"');
    expect(markup).toContain('data-testid="routine-runs-compact-list"');
    expect(markup).toContain('data-testid="routine-run-detail-pane"');
    expect(markup).toContain('data-split-list-header="true"');
    expect(markup).toContain('data-testid="split-dataset-control"');
    expect(markup).not.toContain('data-testid="surface-dataset-control"');
    expect(markup).toContain('data-split-list-header-row="secondary"');
    expect(markup).toContain("mx-0.5");
    expect(markup).toContain('data-testid="routine-search"');
    expect(markup).toContain("w-full min-w-0");
    expect(markup).toContain('data-testid="routine-runs-refresh"');
    expect(markup).toContain('data-testid="split-list-fullscreen-toggle"');
  });

  it("searches runs across their visible identity and status fields", () => {
    const runs = [
      {
        id: "run-42",
        routineName: "Nightly triage",
        routineRevision: 3,
        scopeId: "org2/core",
        status: "succeeded",
        rootWorkItemId: "WI-42",
        createdBy: "scheduler",
        createdAt: 1,
        updatedAt: 2,
      },
    ];

    expect(searchRoutineRuns(runs, "nightly")).toEqual(runs);
    expect(searchRoutineRuns(runs, "wi-42")).toEqual(runs);
    expect(searchRoutineRuns(runs, "failed")).toEqual([]);
  });
});
