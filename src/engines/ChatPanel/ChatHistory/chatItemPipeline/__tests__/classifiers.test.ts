import { describe, expect, it } from "vitest";

import { makeSessionEvent } from "@src/engines/SessionCore/rendering/props/__tests__/fixtures";

import {
  getActionSummaryCategory,
  getToolSimulatorApp,
  isBrowserEvent,
  isEditFileEvent,
  isEventInSimulatorApp,
  isManageTodoEvent,
  isReadFileEvent,
} from "../classifiers";

describe("getActionSummaryCategory", () => {
  it('returns "read" for read_file', () => {
    const event = makeSessionEvent({ function: "read_file" });
    expect(getActionSummaryCategory(event)).toBe("read");
  });

  it('returns "search" for code_search', () => {
    const event = makeSessionEvent({ function: "code_search" });
    expect(getActionSummaryCategory(event)).toBe("search");
  });

  it('returns "list" for list_directory', () => {
    const event = makeSessionEvent({ function: "list_directory" });
    expect(getActionSummaryCategory(event)).toBe("list");
  });

  it('returns "list" for list_dir (builtin name)', () => {
    const event = makeSessionEvent({ function: "list_dir" });
    expect(getActionSummaryCategory(event)).toBe("list");
  });

  it('returns "glob" for glob_file_search', () => {
    const event = makeSessionEvent({ function: "glob_file_search" });
    expect(getActionSummaryCategory(event)).toBe("glob");
  });

  it('returns "glob" for file_search (CLI alias)', () => {
    const event = makeSessionEvent({ function: "file_search" });
    expect(getActionSummaryCategory(event)).toBe("glob");
  });

  it("returns null for edit_file", () => {
    const event = makeSessionEvent({ function: "edit_file" });
    expect(getActionSummaryCategory(event)).toBeNull();
  });

  it("returns null for run_shell", () => {
    const event = makeSessionEvent({ function: "run_shell" });
    expect(getActionSummaryCategory(event)).toBeNull();
  });

  it("returns null for unknown function", () => {
    const event = makeSessionEvent({ function: "unknown_tool" });
    expect(getActionSummaryCategory(event)).toBeNull();
  });
});

describe("isReadFileEvent", () => {
  it("returns true for read_file", () => {
    const event = makeSessionEvent({ function: "read_file" });
    expect(isReadFileEvent(event)).toBe(true);
  });

  it('returns true for CLI alias "Read"', () => {
    const event = makeSessionEvent({ function: "Read" });
    expect(isReadFileEvent(event)).toBe(true);
  });

  it('returns true for CLI alias "cat"', () => {
    const event = makeSessionEvent({ function: "cat" });
    expect(isReadFileEvent(event)).toBe(true);
  });

  it('returns true for CLI alias "file_read"', () => {
    const event = makeSessionEvent({ function: "file_read" });
    expect(isReadFileEvent(event)).toBe(true);
  });

  it("returns false for edit_file", () => {
    const event = makeSessionEvent({ function: "edit_file" });
    expect(isReadFileEvent(event)).toBe(false);
  });

  it("returns false for run_shell", () => {
    const event = makeSessionEvent({ function: "run_shell" });
    expect(isReadFileEvent(event)).toBe(false);
  });
});

describe("registry-backed CLI aliases", () => {
  it('classifies the raw "Grep" alias as search', () => {
    const event = makeSessionEvent({ function: "Grep", uiCanonical: "" });
    expect(getActionSummaryCategory(event)).toBe("search");
  });

  it.each(["Edit", "Write"])(
    'classifies the raw "%s" alias as edit',
    (name) => {
      const event = makeSessionEvent({ function: name, uiCanonical: "" });
      expect(isEditFileEvent(event)).toBe(true);
    }
  );
});

describe("isBrowserEvent", () => {
  it("returns true for tool_call with function=browser", () => {
    const event = makeSessionEvent({
      action_type: "tool_call",
      function: "browser",
    });
    expect(isBrowserEvent(event)).toBe(true);
  });

  it("returns true for tool_call with function=browser_navigate", () => {
    const event = makeSessionEvent({
      action_type: "tool_call",
      function: "browser_navigate",
    });
    expect(isBrowserEvent(event)).toBe(true);
  });

  it("returns true for tool_call with function=browser_act", () => {
    const event = makeSessionEvent({
      action_type: "tool_call",
      function: "browser_act",
    });
    expect(isBrowserEvent(event)).toBe(true);
  });

  it("returns false for tool_call with function=read_file", () => {
    const event = makeSessionEvent({
      action_type: "tool_call",
      function: "read_file",
    });
    expect(isBrowserEvent(event)).toBe(false);
  });

  it("returns false for assistant action_type", () => {
    const event = makeSessionEvent({
      action_type: "assistant",
      function: "browser",
    });
    expect(isBrowserEvent(event)).toBe(false);
  });

  it("returns true for tool_call_start with browser function", () => {
    const event = makeSessionEvent({
      action_type: "tool_call_start",
      function: "browser_navigate",
    });
    expect(isBrowserEvent(event)).toBe(true);
  });

  it("returns true for tool_call_update with browser function", () => {
    const event = makeSessionEvent({
      action_type: "tool_call_update",
      function: "browser_act",
    });
    expect(isBrowserEvent(event)).toBe(true);
  });
});

describe("isManageTodoEvent", () => {
  it("returns true for manage_todo", () => {
    const event = makeSessionEvent({ function: "manage_todo" });
    expect(isManageTodoEvent(event)).toBe(true);
  });

  it("returns true for todo_write (CLI alias)", () => {
    const event = makeSessionEvent({ function: "todo_write" });
    expect(isManageTodoEvent(event)).toBe(true);
  });

  it("returns true for TodoWrite (CLI alias)", () => {
    const event = makeSessionEvent({ function: "TodoWrite" });
    expect(isManageTodoEvent(event)).toBe(true);
  });

  it("returns false for read_file", () => {
    const event = makeSessionEvent({ function: "read_file" });
    expect(isManageTodoEvent(event)).toBe(false);
  });
});

describe("getToolSimulatorApp", () => {
  it('returns "CODE_EDITOR" for read_file (builtin)', () => {
    expect(getToolSimulatorApp("read_file")).toBe("CODE_EDITOR");
  });

  it('returns "CODE_EDITOR" for Read (CLI alias)', () => {
    expect(getToolSimulatorApp("Read")).toBe("CODE_EDITOR");
  });

  it('returns "BROWSER" for browser_navigate (CLI alias)', () => {
    expect(getToolSimulatorApp("browser_navigate")).toBe("BROWSER");
  });

  it("returns null for unknown tool", () => {
    expect(getToolSimulatorApp("completely_unknown_tool")).toBeNull();
  });

  it('returns "CHANNELS" for manage_todo (builtin)', () => {
    expect(getToolSimulatorApp("manage_todo")).toBe("CHANNELS");
  });

  it("uses normalizedName fallback for builtin lookup", () => {
    expect(getToolSimulatorApp("some_unknown_alias", "read_file")).toBe(
      "CODE_EDITOR"
    );
  });
});

describe("isEventInSimulatorApp", () => {
  it("returns true for browser_navigate in BROWSER app", () => {
    const event = makeSessionEvent({
      action_type: "tool_call",
      function: "browser_navigate",
    });
    expect(isEventInSimulatorApp(event, "BROWSER")).toBe(true);
  });

  it("returns false for read_file in BROWSER app", () => {
    const event = makeSessionEvent({
      action_type: "tool_call",
      function: "read_file",
    });
    expect(isEventInSimulatorApp(event, "BROWSER")).toBe(false);
  });

  it("returns true for read_file in CODE_EDITOR app", () => {
    const event = makeSessionEvent({
      action_type: "tool_call",
      function: "read_file",
    });
    expect(isEventInSimulatorApp(event, "CODE_EDITOR")).toBe(true);
  });

  it("returns false for unknown function in any app", () => {
    const event = makeSessionEvent({
      action_type: "tool_call",
      function: "completely_unknown_tool",
    });
    expect(isEventInSimulatorApp(event, "CODE_EDITOR")).toBe(false);
  });
});
