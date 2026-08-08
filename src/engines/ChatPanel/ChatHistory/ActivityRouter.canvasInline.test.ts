import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import {
  getChatComponent,
  loadEventComponent,
} from "@src/engines/SessionCore/rendering/registry/events";
import {
  _resetToolRegistry,
  _setBuiltinChatBlockMap,
} from "@src/engines/SessionCore/rendering/registry/initToolRegistry";

import ActivityChatItem from "./ActivityRouter";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock("@src/engines/ChatPanel/hooks/useChatEventReplay", () => ({
  useChatEventReplay: () => ({
    replayEventById: vi.fn(),
    canReplay: false,
  }),
}));

function createCanvasEvent(
  overrides: Partial<SessionEvent> = {}
): SessionEvent {
  return {
    id: "tool-call-canvas-1",
    sessionId: "session-1",
    actionType: "tool_call",
    functionName: "render_inline_canvas",
    uiCanonical: "canvas_inline",
    args: {
      mode: "url",
      url: "https://example.com/weekend-trip",
      title: "Weekend trip sketch",
    },
    result: { observation: "render_inline_canvas: accepted" },
    displayText: "",
    displayStatus: "completed",
    displayVariant: "tool_call",
    activityStatus: "processed",
    source: "tool",
    createdAt: "2026-08-03T14:53:00.000Z",
    ...overrides,
  } as SessionEvent;
}

describe("ActivityRouter canvas handoff", () => {
  beforeAll(async () => {
    _setBuiltinChatBlockMap(
      new Map([["render_inline_canvas", "canvas_inline"]])
    );
    await loadEventComponent("canvas_inline");
  });

  afterAll(() => {
    _resetToolRegistry();
  });

  it("uses the preloaded renderer synchronously instead of painting a chat loading block", () => {
    const renderer = getChatComponent("canvas_inline");
    expect(typeof renderer).toBe("function");

    const event = createCanvasEvent();
    const directMarkup = renderToStaticMarkup(
      createElement(renderer, { event, variant: "chat" })
    );
    expect(directMarkup).toContain("Weekend trip sketch");

    const markup = renderToStaticMarkup(
      createElement(ActivityChatItem, { event })
    );

    expect(markup).toContain("Weekend trip sketch");
    expect(markup).toContain('data-tool-call-event-id="tool-call-canvas-1"');
    expect(markup).not.toContain('data-testid="chat-loading-block"');
  });

  it("keeps unrelated tool events on their existing renderer path", () => {
    const renderer = getChatComponent("read_file");
    expect(renderer).toBeDefined();
  });
});
