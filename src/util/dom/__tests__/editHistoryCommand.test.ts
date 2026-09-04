// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EDIT_HISTORY_EVENT,
  dispatchEditHistoryCommand,
} from "../editHistoryCommand";

describe("dispatchEditHistoryCommand", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("lets a structured editor consume the command instead of native history", () => {
    const execCommand = vi.fn();
    document.execCommand = execCommand;
    const editor = document.createElement("div");
    editor.tabIndex = 0;
    document.body.appendChild(editor);
    editor.focus();
    const seen: string[] = [];
    editor.addEventListener(EDIT_HISTORY_EVENT.undo, (event) => {
      seen.push(event.type);
      event.preventDefault();
    });

    expect(dispatchEditHistoryCommand("undo")).toBe(true);
    expect(seen).toEqual([EDIT_HISTORY_EVENT.undo]);
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("falls back to native history when nothing consumes the event", () => {
    const execCommand = vi.fn();
    document.execCommand = execCommand;
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();

    expect(dispatchEditHistoryCommand("redo")).toBe(false);
    expect(execCommand).toHaveBeenCalledWith("redo");
  });

  it("bubbles so an ancestor editor host can consume a nested target", () => {
    const execCommand = vi.fn();
    document.execCommand = execCommand;
    const host = document.createElement("div");
    const inner = document.createElement("button");
    host.appendChild(inner);
    document.body.appendChild(host);
    inner.focus();
    host.addEventListener(EDIT_HISTORY_EVENT.undo, (event) =>
      event.preventDefault()
    );

    expect(dispatchEditHistoryCommand("undo")).toBe(true);
    expect(execCommand).not.toHaveBeenCalled();
  });
});
