// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  buildDomComponentJsonFromElementInfo,
  buildDomComponentUserMessage,
  parseCanvasDomComponent,
} from "./domComponentPayload";
import type {
  CanvasDomSelectionMetadata,
  DomSelectionElementInfo,
} from "./types";

function elementInfo(): DomSelectionElementInfo {
  return {
    tagName: "div",
    selector: "main > div.stat",
    id: null,
    className: "stat",
    attributes: { "data-value": "M", onclick: "doBadThing()" },
    innerText: "M Cup size",
    innerHTML: "<strong>M</strong>",
    rect: { x: 20, y: 30, width: 120, height: 80 },
    computedStyle: {
      display: "block",
      position: "static",
      color: "rgb(0, 0, 0)",
      backgroundColor: "rgb(255, 255, 255)",
      fontSize: "28px",
      fontFamily: "sans-serif",
    },
    role: "status",
    xpath: "/main[1]/div[1]",
    sourceLocation: null,
  };
}

describe("Canvas DOM component message", () => {
  it("reuses the dom-component pill while withholding preview HTML from the agent", () => {
    const canvasSelection: CanvasDomSelectionMetadata = {
      schemaVersion: 1,
      origin: "canvas-design",
      canvas: {
        sessionId: "session-a",
        eventId: "event-a",
        mode: "react",
        title: "Coffee",
      },
      selection: {
        kind: "element",
        label: "Stat",
        rect: { x: 20, y: 30, width: 120, height: 80 },
      },
      previewHtml: '<div style="font-size:28px">M</div>',
    };
    const built = buildDomComponentJsonFromElementInfo(
      elementInfo(),
      "canvas://session-a/event-a",
      { displayLabel: "Stat", canvasSelection }
    );
    const message = buildDomComponentUserMessage(
      built,
      "字体变大一些",
      "event-a",
      {
        timestamp: 123,
        currentCanvas: {
          mode: "react",
          content: "function App() { return <div>Original</div>; }",
          title: "Coffee",
        },
      }
    );

    expect(message.displayContent).toContain(
      "Stat [dom-component:paste://canvas-design/event-a/123::"
    );
    expect(message.displayContent).toContain("字体变大一些");
    expect(message.agentContent).toContain("[Canvas Design Selection]");
    expect(message.agentContent).toContain("revise_inline_canvas exactly once");
    expect(message.agentContent).toContain('target_event_id set to "event-a"');
    expect(message.agentContent).toContain(
      "agent_steps before edits or content"
    );
    expect(message.agentContent).toContain("never a fixed template");
    expect(message.agentContent).toContain("user's language");
    expect(message.agentContent).toContain("prefer the compact edits field");
    expect(message.agentContent).toContain(
      "Return complete replacement content only when"
    );
    expect(message.agentContent).toContain("Do not call render_inline_canvas");
    expect(message.agentContent).toContain("do not create a separate Canvas");
    expect(message.agentContent).toContain("Current Canvas Source");
    expect(message.agentContent).toContain("Original");
    expect(message.displayContent).not.toContain("Original");
    expect(message.agentContent).toContain('"eventId": "event-a"');
    expect(message.agentContent).not.toContain("previewHtml");
    expect(message.agentContent).not.toContain("font-size:28px");
    expect(parseCanvasDomComponent(built.jsonText)).toMatchObject({
      origin: "canvas-design",
      canvas: { sessionId: "session-a", eventId: "event-a" },
      selection: { label: "Stat" },
    });
  });

  it("keeps Browser captures compatible with the shared payload", () => {
    const built = buildDomComponentJsonFromElementInfo(
      elementInfo(),
      "https://example.test"
    );
    const parsed = JSON.parse(built.jsonText) as Record<string, unknown>;

    expect(built.fileName).toBe("div.json");
    expect(parsed.cssSelector).toBe("main > div.stat");
    expect(parsed.dataAttributes).toEqual({ "data-value": "M" });
    expect(parseCanvasDomComponent(built.jsonText)).toBeNull();
  });
});
