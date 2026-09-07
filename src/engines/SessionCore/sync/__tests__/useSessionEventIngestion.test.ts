// @vitest-environment jsdom
import React, { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  subscribeToSessionEventIngestion,
  useSessionEventIngestion,
} from "../useSessionEventIngestion";

const mocks = vi.hoisted(() => ({
  createEventHandler: vi.fn(),
  dispose: vi.fn(),
  handleEvent: vi.fn(),
  listener: null as ((raw: string) => void) | null,
  subscribeToSessionEvents: vi.fn(),
  unsubscribeChannel: vi.fn(),
}));

vi.mock("@src/engines/SessionCore/sync/adapters", () => ({}));
vi.mock("@src/engines/SessionCore/sync/types", () => ({
  getAdapterForSession: () => ({
    createEventHandler: mocks.createEventHandler,
  }),
}));
vi.mock("@src/engines/SessionCore/sync/useSessionChannel", () => ({
  subscribeToSessionEvents: mocks.subscribeToSessionEvents,
}));

function Harness({ sessionId }: { sessionId: string | null }) {
  useSessionEventIngestion(sessionId);
  return null;
}

describe("useSessionEventIngestion", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    mocks.createEventHandler.mockReset();
    mocks.dispose.mockReset();
    mocks.handleEvent.mockReset();
    mocks.subscribeToSessionEvents.mockReset();
    mocks.unsubscribeChannel.mockReset();
    mocks.createEventHandler.mockReturnValue({
      dispose: mocks.dispose,
      handleEvent: mocks.handleEvent,
    });
    mocks.listener = null;
    mocks.subscribeToSessionEvents.mockImplementation(
      (_sessionId: string, listener: (raw: string) => void) => {
        mocks.listener = listener;
        return mocks.unsubscribeChannel;
      }
    );
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("feeds a hidden session's shared channel into its registered adapter", () => {
    act(() =>
      root.render(
        React.createElement(Harness, { sessionId: "cliagent-hidden" })
      )
    );

    expect(mocks.createEventHandler).toHaveBeenCalledWith(
      "cliagent-hidden",
      {}
    );
    expect(mocks.subscribeToSessionEvents).toHaveBeenCalledWith(
      "cliagent-hidden",
      expect.any(Function)
    );

    act(() => {
      mocks.listener?.(
        JSON.stringify({
          type: "code_session.activity",
          session_id: "cliagent-hidden",
          data: { type: "assistant", content: "live output" },
        })
      );
    });

    expect(mocks.handleEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "code_session.activity",
        session_id: "cliagent-hidden",
      })
    );
  });

  it("disposes the old adapter and does not subscribe without a session", () => {
    act(() =>
      root.render(
        React.createElement(Harness, { sessionId: "cliagent-hidden" })
      )
    );
    act(() => root.render(React.createElement(Harness, { sessionId: null })));

    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(mocks.unsubscribeChannel).toHaveBeenCalledOnce();
  });

  it("shares one stateful handler across hidden surfaces", () => {
    const disposeFirst = subscribeToSessionEventIngestion("cliagent-shared");
    const disposeSecond = subscribeToSessionEventIngestion("cliagent-shared");

    expect(mocks.createEventHandler).toHaveBeenCalledOnce();
    expect(mocks.subscribeToSessionEvents).toHaveBeenCalledOnce();
    disposeFirst();
    expect(mocks.dispose).not.toHaveBeenCalled();
    expect(mocks.unsubscribeChannel).not.toHaveBeenCalled();
    disposeSecond();
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(mocks.unsubscribeChannel).toHaveBeenCalledOnce();
  });
});
