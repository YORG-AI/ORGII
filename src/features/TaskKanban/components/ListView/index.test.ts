// @vitest-environment jsdom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { KanbanTask } from "@src/features/KanbanBoard";

import ListView from ".";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { resolvedLanguage: "en" },
  }),
}));

const task: KanbanTask = {
  id: "cloud-remote:session-1",
  title: "Teammate session",
  status: "in_progress",
  created_at: "2026-07-22T12:00:00.000Z",
  updated_at: "2026-07-22T12:01:00.000Z",
  createdBy: { id: "teammate-1", name: "Teammate" },
};

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("TaskKanban ListView", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserverMock {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
    vi.unstubAllGlobals();
  });

  it("renders the supplied Take over action without also selecting the row", async () => {
    const takeOver = vi.fn();
    const onTaskClick = vi.fn();
    await act(async () => {
      root.render(
        createElement(ListView, {
          tasks: [task],
          selectedTaskId: null,
          detailPanelVisible: false,
          onTaskClick,
          renderRowAction: () =>
            createElement(
              "button",
              {
                type: "button",
                onClick: takeOver,
                "data-testid": "take-over",
              },
              "Take over"
            ),
        })
      );
    });

    expect(
      container.querySelector('[data-testid="kanban-list-session-row"]')
    ).not.toBeNull();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="take-over"]')
        ?.click()
    );

    expect(takeOver).toHaveBeenCalledTimes(1);
    expect(onTaskClick).not.toHaveBeenCalled();
  });

  it("combines files and line changes into one files-first column", async () => {
    await act(async () => {
      root.render(
        createElement(ListView, {
          tasks: [
            {
              ...task,
              impact: {
                filesChanged: 46,
                linesAdded: 927,
                linesRemoved: 606,
                relatedCommits: 7,
                committedFiles: 0,
                committedRatePercent: 0,
              },
            },
          ],
          selectedTaskId: null,
          detailPanelVisible: false,
          onTaskClick: vi.fn(),
        })
      );
    });

    const headerLabels = Array.from(container.querySelectorAll("th")).map(
      (header) => header.textContent?.replace(/\s+/g, " ").trim()
    );
    expect(headerLabels).toContain(
      "common:labels.files · common:aiImpact.lines"
    );
    expect(headerLabels).not.toContain("common:labels.files");
    expect(headerLabels).not.toContain("common:labels.commits");

    const row = container.querySelector(
      '[data-testid="kanban-list-session-row"]'
    );
    expect(row?.textContent).toContain("46·+927-606");
  });

  it("omits the table search because the Kanban header owns session search", async () => {
    await act(async () => {
      root.render(
        createElement(ListView, {
          tasks: [task],
          selectedTaskId: null,
          detailPanelVisible: false,
          onTaskClick: vi.fn(),
        })
      );
    });

    expect(container.querySelector('input[type="search"]')).toBeNull();
  });

  it("defaults to 25 rows and offers only 25 or 50 per page", async () => {
    await act(async () => {
      root.render(
        createElement(ListView, {
          tasks: Array.from({ length: 51 }, (_, index) => ({
            ...task,
            id: `session-${index}`,
            title: `Session ${index}`,
          })),
          selectedTaskId: null,
          detailPanelVisible: false,
          onTaskClick: vi.fn(),
        })
      );
    });

    expect(
      container.querySelectorAll('[data-testid="kanban-list-session-row"]')
    ).toHaveLength(25);

    const selectWrappers =
      container.querySelectorAll<HTMLElement>(".select-wrapper");
    // The shared pagination footer places page size first and the page picker
    // in the centered navigation controls.
    const pageSizeSelect = selectWrappers[0];
    expect(pageSizeSelect?.textContent).toContain("25 pagination.perPage");
    expect(selectWrappers[1]?.textContent).toContain("pagination.pageOf");
    await act(async () => pageSizeSelect?.click());

    const optionsContainer = document.body.querySelector(
      ".dropdown-options-scrollbar > div"
    );
    const pageSizeOptions = Array.from(optionsContainer?.children ?? [])
      .map((option) => option.textContent?.trim())
      .filter(Boolean);
    expect(pageSizeOptions).toEqual([
      "25 pagination.perPage",
      "50 pagination.perPage",
    ]);
  });
});
