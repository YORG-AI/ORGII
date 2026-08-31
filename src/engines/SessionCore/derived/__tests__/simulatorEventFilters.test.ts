import { describe, expect, it } from "vitest";

import type { SessionEvent, SimulatorEventPreview } from "../../core/types";
import {
  getFallbackSimulatorEventFilterCategory,
  isSimulatorEventVisibleForFilters,
} from "../simulatorEventFilters";

function preview(
  overrides: Partial<SimulatorEventPreview>
): SimulatorEventPreview {
  return {
    id: "event-1",
    sessionId: "session-1",
    createdAt: "2026-06-22T00:00:00.000Z",
    functionName: "noop",
    uiCanonical: "noop",
    actionType: "tool_call",
    source: "assistant",
    displayText: "Noop",
    displayStatus: "completed",
    displayVariant: "tool_call",
    activityStatus: "processed",
    filterCategory: "other",
    ...overrides,
  };
}

function event(overrides: Partial<SessionEvent>): SessionEvent {
  return {
    chunk_id: "event-1",
    id: "event-1",
    sessionId: "session-1",
    createdAt: "2026-06-22T00:00:00.000Z",
    functionName: "noop",
    uiCanonical: "noop",
    actionType: "tool_call",
    args: {},
    result: {},
    source: "assistant",
    displayText: "Noop",
    displayStatus: "completed",
    displayVariant: "tool_call",
    activityStatus: "processed",
    ...overrides,
  };
}

describe("simulator event filters", () => {
  it("keeps all events visible when no filters are selected", () => {
    expect(
      isSimulatorEventVisibleForFilters(
        preview({ filterCategory: "file_changes" }),
        []
      )
    ).toBe(true);
  });

  it("uses the Rust-provided preview filter category", () => {
    expect(
      isSimulatorEventVisibleForFilters(
        preview({
          uiCanonical: "read_file",
          filePath: "src/App.tsx",
          filterCategory: "explore",
        }),
        ["explore"]
      )
    ).toBe(true);
    expect(
      isSimulatorEventVisibleForFilters(
        preview({
          uiCanonical: "read_file",
          filePath: "src/App.tsx",
          filterCategory: "explore",
        }),
        ["file_changes"]
      )
    ).toBe(false);
  });

  it("supports multi-category selection", () => {
    const event = preview({ filterCategory: "terminal_events" });

    expect(
      isSimulatorEventVisibleForFilters(event, [
        "file_changes",
        "terminal_events",
      ])
    ).toBe(true);
    expect(isSimulatorEventVisibleForFilters(event, ["file_changes"])).toBe(
      false
    );
  });

  it("derives fallback categories for single-category filtering without snapshot previews", () => {
    expect(
      getFallbackSimulatorEventFilterCategory(event({ source: "user" }))
    ).toBe("key_interactions");
    expect(
      getFallbackSimulatorEventFilterCategory(
        event({ uiCanonical: "edit_file" })
      )
    ).toBe("file_changes");
    expect(
      getFallbackSimulatorEventFilterCategory(
        event({ uiCanonical: "run_shell", command: "pnpm test" })
      )
    ).toBe("terminal_events");
    expect(
      getFallbackSimulatorEventFilterCategory(
        event({ uiCanonical: "code_search" })
      )
    ).toBe("explore");
    expect(getFallbackSimulatorEventFilterCategory(event({}))).toBe("other");
  });
});
