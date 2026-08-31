import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { SessionViewMode } from "./hooks/useSessionViewMode";

vi.mock("./SessionContentView", () => ({
  default: ({ sessionId }: { sessionId: string }) =>
    createElement("div", { "data-gui-session": sessionId }),
}));

const { ChatPanelContent } = await import("./ChatPanelContent");

function render(sessionViewMode: SessionViewMode): string {
  return renderToStaticMarkup(
    createElement(ChatPanelContent, {
      currentSessionId: "s-1",
      displayMode: "full" as const,
      emptyChatContent: createElement("div", { "data-empty": "true" }),
      onSessionContinuation: () => undefined,
      paginationEnabled: false,
      position: "right" as const,
      showPanelContent: true,
      showSessionContent: true,
      sessionViewMode,
      alternateSessionView: createElement("div", {
        "data-alternate-session": sessionViewMode,
      }),
    })
  );
}

const ALTERNATE_MODES: SessionViewMode[] = ["timeline", "changes", "raw"];

describe("ChatPanelContent session views", () => {
  it("shows the transcript and mounts no alternate view in gui mode", () => {
    const markup = render("gui");

    expect(markup).toContain(
      '<div class="min-h-0 flex-1 flex-col flex"><div data-gui-session="s-1">'
    );
    expect(markup).not.toContain("data-alternate-session");
  });

  it.each(ALTERNATE_MODES)(
    "keeps the transcript mounted but hidden in %s mode",
    (mode) => {
      // Regression guard for the virtualized chat list: unmounting the GUI
      // subtree on every view switch would drop TanStack Virtual's measurement
      // cache and force a full re-measure of every turn on the way back. The
      // wrapper must flip to `hidden`, with the transcript still in the tree.
      const markup = render(mode);

      expect(markup).toContain(
        '<div class="min-h-0 flex-1 flex-col hidden"><div data-gui-session="s-1">'
      );
    }
  );

  it.each(ALTERNATE_MODES)("mounts the alternate view in %s mode", (mode) => {
    expect(render(mode)).toContain(`data-alternate-session="${mode}"`);
  });
});
