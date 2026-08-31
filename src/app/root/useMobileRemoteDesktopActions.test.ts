// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { useMobileRemoteDesktopActions } from "./useMobileRemoteDesktopActions";

const mocks = vi.hoisted(() => ({
  listener: null as ((payload: unknown) => void) | null,
  openSession: vi.fn(() => Promise.resolve()),
  openFile: vi.fn(),
}));

vi.mock("@src/hooks/platform/useTauriListen", () => ({
  useTauriListen: (_event: string, listener: (payload: unknown) => void) => {
    mocks.listener = listener;
  },
}));

vi.mock("@src/engines/SessionCore/services", () => ({
  SessionService: { open: mocks.openSession },
}));

vi.mock("@src/util/ui/openFileInWorkStation", () => ({
  openFileInWorkStation: mocks.openFile,
}));

function Probe() {
  useMobileRemoteDesktopActions();
  return null;
}

describe("useMobileRemoteDesktopActions", () => {
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  afterEach(() => {
    mocks.listener = null;
    vi.clearAllMocks();
  });

  it("switches to the owning session before revealing the file and line", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => root.render(React.createElement(Probe)));

    await act(async () => {
      mocks.listener?.({
        sessionId: "session-a",
        filePath: "/repo/src/app.ts",
        line: 42,
      });
      await Promise.resolve();
    });

    expect(mocks.openSession).toHaveBeenCalledWith({ sessionId: "session-a" });
    expect(mocks.openFile).toHaveBeenCalledWith("/repo/src/app.ts", {
      line: 42,
    });
    expect(mocks.openSession.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.openFile.mock.invocationCallOrder[0]
    );
    act(() => root.unmount());
  });

  it("ignores malformed event payloads", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => root.render(React.createElement(Probe)));
    act(() => mocks.listener?.({ sessionId: "session-a", filePath: "" }));
    expect(mocks.openSession).not.toHaveBeenCalled();
    expect(mocks.openFile).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});
