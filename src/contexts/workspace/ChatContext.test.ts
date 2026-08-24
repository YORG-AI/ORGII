/** @vitest-environment jsdom */
import { Provider, createStore } from "jotai";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatHistoryOverrideContext } from "@src/engines/ChatPanel/ChatHistoryOverrideContext";
import { ChatSessionContext } from "@src/engines/ChatPanel/ChatSessionContext";
import type { SessionEvent } from "@src/engines/SessionCore";
import { createSmokeRoot } from "@src/test/reactSmokeHarness";

import { useChatHistory } from "./ChatContext";

const mocks = vi.hoisted(() => ({
  sessionEventsFamily: vi.fn(),
  planningMetaFamily: vi.fn(),
}));

vi.mock("@src/engines/SessionCore/derived/sessionScopedChatEvents", () => ({
  chatEventsForSessionAtomFamily: (...args: unknown[]) =>
    mocks.sessionEventsFamily(...args),
  sessionScopedPlanningMetaAtomFamily: (...args: unknown[]) =>
    mocks.planningMetaFamily(...args),
}));

function Probe() {
  const history = useChatHistory();
  return React.createElement(
    "div",
    {
      "data-source-session": history.sourceSessionId ?? "",
      "data-source-override": String(history.sourceIsOverride),
    },
    history.chatHistory.map((event) => event.id).join(",")
  );
}

describe("useChatHistory override source", () => {
  const roots: Array<ReturnType<typeof createSmokeRoot>> = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => root.unmount()));
    vi.clearAllMocks();
  });

  it("does not subscribe to the desktop session atom family", async () => {
    const events = [{ id: "cloud-event" }] as SessionEvent[];
    const root = createSmokeRoot();
    roots.push(root);
    await root.render(
      React.createElement(
        Provider,
        { store: createStore() },
        React.createElement(
          ChatSessionContext.Provider,
          { value: "cloud-session" },
          React.createElement(
            ChatHistoryOverrideContext.Provider,
            { value: events },
            React.createElement(Probe)
          )
        )
      )
    );

    expect(root.container.textContent).toBe("cloud-event");
    expect(
      root.container.firstElementChild?.getAttribute("data-source-session")
    ).toBe("cloud-session");
    expect(
      root.container.firstElementChild?.getAttribute("data-source-override")
    ).toBe("true");
    expect(mocks.sessionEventsFamily).not.toHaveBeenCalled();
    expect(mocks.planningMetaFamily).not.toHaveBeenCalled();
  });
});
