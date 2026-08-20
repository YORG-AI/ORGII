import { createStore } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bufferCanvasRevisionDraft,
  canvasRevisionDraftsAtom,
  clearCanvasRevisionDraft,
  disposeCanvasRevisionDraftState,
  markCanvasRevisionDraftApplying,
} from "../canvasRevisionDraftAtom";

describe("canvasRevisionDraftAtom", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers the first chunk immediately and coalesces later chunks", () => {
    vi.useFakeTimers();
    const store = createStore();
    const base = {
      sessionId: "session-a",
      toolCallId: "revision-a",
      targetEventId: "canvas-a",
      agentSteps: ["替换按钮文案", "核对原有交互"],
      phase: "receiving" as const,
    };

    bufferCanvasRevisionDraft(store, { ...base, receivedCharacters: 10 });
    expect(
      store.get(canvasRevisionDraftsAtom).get("session-a")?.receivedCharacters
    ).toBe(10);

    bufferCanvasRevisionDraft(store, { ...base, receivedCharacters: 20 });
    bufferCanvasRevisionDraft(store, { ...base, receivedCharacters: 30 });
    expect(
      store.get(canvasRevisionDraftsAtom).get("session-a")?.receivedCharacters
    ).toBe(10);

    vi.advanceTimersByTime(50);
    expect(
      store.get(canvasRevisionDraftsAtom).get("session-a")?.receivedCharacters
    ).toBe(30);
  });

  it("preserves operation identity through applying and ignores a stale clear", () => {
    const store = createStore();
    bufferCanvasRevisionDraft(store, {
      sessionId: "session-a",
      toolCallId: "revision-a",
      agentSteps: ["替换按钮文案", "核对原有交互"],
      receivedCharacters: 10,
      phase: "receiving",
    });

    markCanvasRevisionDraftApplying(store, "session-a", "revision-a", 42);
    expect(store.get(canvasRevisionDraftsAtom).get("session-a")).toMatchObject({
      toolCallId: "revision-a",
      receivedCharacters: 42,
      phase: "applying",
      agentSteps: ["替换按钮文案", "核对原有交互"],
    });

    clearCanvasRevisionDraft(store, "session-a", "older-revision");
    expect(store.get(canvasRevisionDraftsAtom).has("session-a")).toBe(true);

    clearCanvasRevisionDraft(store, "session-a", "revision-a");
    expect(store.get(canvasRevisionDraftsAtom).has("session-a")).toBe(false);
  });

  it("releases pending and visible state on permanent session disposal", () => {
    vi.useFakeTimers();
    const store = createStore();
    bufferCanvasRevisionDraft(store, {
      sessionId: "session-a",
      toolCallId: "revision-a",
      receivedCharacters: 10,
      phase: "receiving",
    });
    bufferCanvasRevisionDraft(store, {
      sessionId: "session-a",
      toolCallId: "revision-a",
      receivedCharacters: 20,
      phase: "receiving",
    });

    disposeCanvasRevisionDraftState(store, "session-a");
    vi.advanceTimersByTime(100);

    expect(store.get(canvasRevisionDraftsAtom).has("session-a")).toBe(false);
  });
});
