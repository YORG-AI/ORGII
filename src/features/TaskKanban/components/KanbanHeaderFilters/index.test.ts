// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
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
import { kanbanAgentTypeFilterAtom } from "@src/store/ui/kanbanViewStateAtom";

import KanbanHeaderFilters from ".";
import { KANBAN_AGENT_TYPE_FILTER } from "../../config";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const tasks: KanbanTask[] = [
  {
    id: "session-1",
    title: "Session one",
    status: "in_progress",
    agentTypeFilter: KANBAN_AGENT_TYPE_FILTER.CODEX_APP,
    agentTypeFilterKind: "external",
  },
];

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("KanbanHeaderFilters", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createStore>;
  let onAutoArchiveTtlChange: ReturnType<typeof vi.fn>;
  let onTimeFilterChange: ReturnType<typeof vi.fn>;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(async () => {
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    store = createStore();
    store.set(kanbanAgentTypeFilterAtom, KANBAN_AGENT_TYPE_FILTER.ALL);
    onAutoArchiveTtlChange = vi.fn();
    onTimeFilterChange = vi.fn();

    await act(async () => {
      root.render(
        createElement(
          Provider,
          { store },
          createElement(KanbanHeaderFilters, {
            tasks,
            autoArchiveTtl: "24h",
            onAutoArchiveTtlChange,
            timeFilter: "3d",
            onTimeFilterChange,
          })
        )
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  async function openFilterMenu(): Promise<void> {
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="kanban-filter-menu-trigger"]'
        )
        ?.click();
    });
  }

  it("consolidates Agent, Auto archive, and Range into second-level menus", async () => {
    const trigger = container.querySelector(
      '[data-testid="kanban-filter-menu-trigger"]'
    );
    expect(trigger?.getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector(".select-wrapper")).toBeNull();

    await openFilterMenu();

    expect(
      document.body.querySelector('[data-testid="kanban-filter-agent-submenu"]')
    ).not.toBeNull();
    expect(
      document.body.querySelector(
        '[data-testid="kanban-filter-auto-archive-submenu"]'
      )
    ).not.toBeNull();
    expect(
      document.body.querySelector('[data-testid="kanban-filter-range-submenu"]')
    ).not.toBeNull();
  });

  it("updates each filter from its submenu", async () => {
    await openFilterMenu();

    await act(async () => {
      document.body
        .querySelector<HTMLElement>(
          '[data-testid="kanban-filter-agent-submenu"]'
        )
        ?.click();
    });
    await act(async () => {
      document.body
        .querySelector<HTMLElement>(
          '[data-testid="kanban-filter-agent-codex_app"]'
        )
        ?.click();
    });
    expect(store.get(kanbanAgentTypeFilterAtom)).toBe(
      KANBAN_AGENT_TYPE_FILTER.CODEX_APP
    );

    await act(async () => {
      document.body
        .querySelector<HTMLElement>(
          '[data-testid="kanban-filter-auto-archive-submenu"]'
        )
        ?.click();
    });
    await act(async () => {
      document.body
        .querySelector<HTMLElement>(
          '[data-testid="kanban-filter-auto-archive-7d"]'
        )
        ?.click();
    });
    expect(onAutoArchiveTtlChange).toHaveBeenCalledWith("7d");

    await act(async () => {
      document.body
        .querySelector<HTMLElement>(
          '[data-testid="kanban-filter-range-submenu"]'
        )
        ?.click();
    });
    await act(async () => {
      document.body
        .querySelector<HTMLElement>('[data-testid="kanban-filter-range-24h"]')
        ?.click();
    });
    expect(onTimeFilterChange).toHaveBeenCalledWith("24h");
  });
});
