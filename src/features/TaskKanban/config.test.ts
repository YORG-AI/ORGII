import { describe, expect, it } from "vitest";

import {
  EXTERNAL_HISTORY_FILTER_BY_SOURCE,
  KANBAN_AGENT_TYPE_FILTER,
} from "./config";

describe("Task Kanban external-history filters", () => {
  it("maps Warp imported sessions to the Warp filter", () => {
    expect(EXTERNAL_HISTORY_FILTER_BY_SOURCE.warp).toBe(
      KANBAN_AGENT_TYPE_FILTER.WARP_APP
    );
  });
});
