import { describe, expect, it } from "vitest";

import {
  DEFAULT_KANBAN_TIME_FILTER,
  EXTERNAL_HISTORY_FILTER_BY_SOURCE,
  KANBAN_AGENT_TYPE_FILTER,
} from "./config";

describe("Task Kanban defaults", () => {
  it("starts with a three-day activity window", () => {
    expect(DEFAULT_KANBAN_TIME_FILTER).toBe("3d");
  });
});

describe("Task Kanban external-history filters", () => {
  it("maps Warp imported sessions to the Warp filter", () => {
    expect(EXTERNAL_HISTORY_FILTER_BY_SOURCE.warp).toBe(
      KANBAN_AGENT_TYPE_FILTER.WARP_APP
    );
  });

  it("maps newly imported CLI histories to distinct filters", () => {
    expect(EXTERNAL_HISTORY_FILTER_BY_SOURCE.mimo_code).toBe(
      KANBAN_AGENT_TYPE_FILTER.MIMO_CODE_APP
    );
    expect(EXTERNAL_HISTORY_FILTER_BY_SOURCE.omp).toBe(
      KANBAN_AGENT_TYPE_FILTER.OMP_APP
    );
    expect(EXTERNAL_HISTORY_FILTER_BY_SOURCE.pi).toBe(
      KANBAN_AGENT_TYPE_FILTER.PI_APP
    );
    expect(EXTERNAL_HISTORY_FILTER_BY_SOURCE.qoder_cli).toBe(
      KANBAN_AGENT_TYPE_FILTER.QODER_CLI_APP
    );
    expect(EXTERNAL_HISTORY_FILTER_BY_SOURCE.qwen_code).toBe(
      KANBAN_AGENT_TYPE_FILTER.QWEN_CODE_APP
    );
    expect(EXTERNAL_HISTORY_FILTER_BY_SOURCE.copilot).toBe(
      KANBAN_AGENT_TYPE_FILTER.COPILOT_APP
    );
    expect(EXTERNAL_HISTORY_FILTER_BY_SOURCE.kimi).toBe(
      KANBAN_AGENT_TYPE_FILTER.KIMI_CLI
    );
  });
});
