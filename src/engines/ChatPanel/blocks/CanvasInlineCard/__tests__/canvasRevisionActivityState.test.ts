import { describe, expect, it } from "vitest";

import {
  getCanvasRevisionStepStates,
  summarizeCanvasRevisionActivity,
} from "../canvasRevisionActivityState";

describe("Canvas revision activity state", () => {
  it("moves the factual work steps through receiving, applying, and completion", () => {
    expect(getCanvasRevisionStepStates("receiving", 2)).toEqual([
      "active",
      "pending",
    ]);
    expect(getCanvasRevisionStepStates("applying", 2)).toEqual([
      "active",
      "pending",
    ]);
    expect(getCanvasRevisionStepStates("completed", 2)).toEqual([
      "complete",
      "complete",
    ]);
  });

  it("marks failure without claiming later agent steps ran", () => {
    expect(getCanvasRevisionStepStates("failed", 3)).toEqual([
      "failed",
      "pending",
      "pending",
    ]);
    expect(getCanvasRevisionStepStates("completed", 0)).toEqual([]);
  });

  it("summarizes compact edits without exposing source contents", () => {
    expect(
      summarizeCanvasRevisionActivity({
        title: "Coffee sketch",
        edits: [
          { find: "Start", replace: "Start setup" },
          { find: "13px", replace: "15px" },
        ],
        agent_steps: ["替换按钮文案", "核对原有交互"],
      })
    ).toEqual({
      title: "Coffee sketch",
      changeKind: "targeted",
      editCount: 2,
      payloadCharacters: 0,
      agentSteps: ["替换按钮文案", "核对原有交互"],
    });
  });

  it("distinguishes full replacements, URLs, and empty legacy payloads", () => {
    expect(
      summarizeCanvasRevisionActivity({ content: "function App() {}" })
    ).toMatchObject({ changeKind: "replacement", payloadCharacters: 17 });
    expect(
      summarizeCanvasRevisionActivity({ url: "https://example.com" })
    ).toMatchObject({ changeKind: "url" });
    expect(summarizeCanvasRevisionActivity({})).toMatchObject({
      changeKind: "unknown",
    });
  });
});
