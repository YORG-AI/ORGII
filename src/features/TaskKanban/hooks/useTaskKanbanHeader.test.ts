import { type ReactNode, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { useTaskKanbanHeader } from "./useTaskKanbanHeader";

const publishState = vi.hoisted(() => ({ content: null as unknown }));

vi.mock("@src/hooks/tabHost/useWorkstationTabHeader", () => ({
  usePublishWorkstationTabHeader: ({ content }: { content: unknown }) => {
    publishState.content = content;
  },
}));

vi.mock("../components/KanbanSearchInput", async () => {
  const React = await import("react");
  return {
    default: () =>
      React.createElement("span", { "data-testid": "kanban-search-control" }),
  };
});

vi.mock("../components/KanbanHeaderFilters", async () => {
  const React = await import("react");
  return {
    default: () =>
      React.createElement("span", { "data-testid": "kanban-filter-control" }),
  };
});

interface PublishedHeader {
  trailing?: ReactNode;
}

function HeaderHarness({
  onAddTask,
  addTaskActive = false,
}: {
  onAddTask?: () => void;
  addTaskActive?: boolean;
}) {
  useTaskKanbanHeader({
    viewMode: "kanban",
    calendarDate: new Date("2026-09-02T00:00:00Z"),
    onCalendarDateChange: vi.fn(),
    autoArchiveTtl: "24h",
    onAutoArchiveTtlChange: vi.fn(),
    timeFilter: "3d",
    onTimeFilterChange: vi.fn(),
    tasks: [],
    addTaskLabel: "New session",
    addTaskActive,
    onAddTask,
    hidden: false,
  });
  return null;
}

function renderPublishedTrailing({
  onAddTask,
  addTaskActive = false,
}: {
  onAddTask?: () => void;
  addTaskActive?: boolean;
} = {}): string {
  publishState.content = null;
  renderToStaticMarkup(
    createElement(HeaderHarness, { onAddTask, addTaskActive })
  );
  const trailing = (publishState.content as PublishedHeader | null)?.trailing;
  return renderToStaticMarkup(createElement("div", null, trailing));
}

describe("useTaskKanbanHeader", () => {
  it("orders search, separator, filter, and create controls", () => {
    const markup = renderPublishedTrailing({ onAddTask: vi.fn() });
    const searchIndex = markup.indexOf('data-testid="kanban-search-control"');
    const separatorIndex = markup.indexOf("bg-border-2");
    const filterIndex = markup.indexOf('data-testid="kanban-filter-control"');
    const createIndex = markup.indexOf('data-testid="kanban-create-session"');

    expect(searchIndex).toBeGreaterThanOrEqual(0);
    expect(searchIndex).toBeLessThan(separatorIndex);
    expect(separatorIndex).toBeLessThan(filterIndex);
    expect(filterIndex).toBeLessThan(createIndex);
    expect(markup).toContain('data-icon="message-add"');
    expect(markup).not.toContain('data-icon="plus"');
  });

  it("highlights the New Session action while the creator is visible", () => {
    const markup = renderPublishedTrailing({
      onAddTask: vi.fn(),
      addTaskActive: true,
    });

    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain("bg-surface-selected! text-primary-6!");
  });

  it("omits the create action when the host disables session creation", () => {
    expect(renderPublishedTrailing()).not.toContain(
      'data-testid="kanban-create-session"'
    );
  });
});
