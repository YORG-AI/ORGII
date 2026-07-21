import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import TerminalBlock from ".";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("TerminalBlock shell replay", () => {
  it("renders the bounded replay preview in the expanded chat body", () => {
    const markup = renderToStaticMarkup(
      createElement(TerminalBlock, {
        command: "printf replay",
        output: "legacy output must not win",
        defaultCollapsed: false,
        eventId: "tool-call-1",
        sessionId: "session-1",
        replayRef: {
          sessionId: "session-1",
          callId: "call-1",
          formatVersion: 1,
        },
        replayState: {
          ref: {
            sessionId: "session-1",
            callId: "call-1",
            formatVersion: 1,
          },
          bookmark: {
            visibleThroughSequence: 2,
            visibleBytes: 18,
          },
          terminalPreview: "bounded replay tail",
          status: "running",
        },
      })
    );

    expect(markup).toContain("bounded replay tail");
    expect(markup).not.toContain("legacy output must not win");
    expect(markup).toContain("max-height:min(320px, 30vh)");
  });
});
