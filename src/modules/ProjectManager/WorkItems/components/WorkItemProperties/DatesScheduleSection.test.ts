import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { WorkItem } from "@src/types/core/workItem";

import { DatesScheduleSection } from "./DatesScheduleSection";
import type {
  WorkItemPropertyFieldKey,
  WorkItemPropertyHandlers,
} from "./types";

const workItem = {
  session_id: "work-item-1",
  user_id: "user-1",
  name: "Date spacing",
  status: "backlog",
  star: false,
  target_date: null,
  endDate: "2026-07-29T08:00:00.000Z",
  created_time: "2026-07-28T00:00:00.000Z",
  updated_time: "2026-07-28T00:00:00.000Z",
} as WorkItem;

const handlers = {
  formatDueDate: () => "Tomorrow",
  getRelativeTime: () => "In 9 hours",
  handleDateChange: vi.fn(),
} as unknown as WorkItemPropertyHandlers;

function renderDateField(fieldVariant: "pill" | "row") {
  return renderToStaticMarkup(
    createElement(DatesScheduleSection, {
      workItem,
      openPicker: null,
      togglePicker: vi.fn(),
      handlers,
      showTime: true,
      t: (key: string) => key,
      fieldVariant,
      visibleFields: new Set<WorkItemPropertyFieldKey>(["date"]),
    })
  );
}

describe("DatesScheduleSection", () => {
  it("separates the relative time from the date label in compact pills", () => {
    const markup = renderDateField("pill");

    expect(markup).toContain("Tomorrow");
    expect(markup).toContain("In 9 hours");
    expect(markup).toContain('class="ml-1 shrink-0');
  });

  it("keeps relative time aligned to the trailing edge in property rows", () => {
    expect(renderDateField("row")).toContain('class="ml-auto shrink-0');
  });
});
