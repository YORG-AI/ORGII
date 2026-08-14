// @vitest-environment jsdom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { TerminalCore } from "../index";
import type { UseTerminalStateReturn } from "../types";

const { terminalMounted, terminalUnmounted } = vi.hoisted(() => ({
  terminalMounted: vi.fn(),
  terminalUnmounted: vi.fn(),
}));

vi.mock("jotai", () => ({ useSetAtom: () => vi.fn() }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/src/scaffold/ContextMenu/exports", () => ({
  TextSelectionDropdown: () => null,
}));
vi.mock("@src/components/Message", () => ({
  default: { success: vi.fn() },
}));
vi.mock("@src/hooks/terminal", () => ({
  useTerminalProcessPoller: () => undefined,
}));
vi.mock("@src/modules/shared/layouts/blocks", () => ({
  Placeholder: () => createElement("div", { "data-placeholder": true }),
}));
vi.mock("@src/store/ui/addToAgentAtom", () => ({ addToAgentAtom: {} }));
vi.mock("@src/store/ui/chatPanelAtom", () => ({
  activeStationChatVisibleAtom: {},
}));
vi.mock("@src/store/workstation/codeEditor/terminal/commandDetection", () => ({
  commandCwdChangedAtom: {},
  commandExecutedAtom: {},
  commandFinishedAtom: {},
  commandPromptStartAtom: {},
}));
vi.mock("../components/TerminalSearchPanel", () => ({
  TerminalSearchPanel: () => null,
}));
vi.mock("@src/components/TerminalInteractive", async () => {
  const React = await import("react");
  return {
    TerminalView: React.forwardRef(function MockTerminalView(
      { sessionKey }: { sessionKey: string },
      _ref
    ) {
      React.useEffect(() => {
        terminalMounted(sessionKey);
        return () => terminalUnmounted(sessionKey);
      }, [sessionKey]);
      return React.createElement("div", {
        "data-terminal-session": sessionKey,
      });
    }),
  };
});

function createTerminalState(activeSessionId: string): UseTerminalStateReturn {
  const sessions = [
    {
      id: "terminal-a",
      name: "Terminal A",
      isActive: activeSessionId === "terminal-a",
    },
    {
      id: "terminal-b",
      name: "Terminal B",
      isActive: activeSessionId === "terminal-b",
    },
  ];
  return {
    sessions,
    activeSessionId,
    activeSession: sessions.find((session) => session.id === activeSessionId),
    initializedSessions: new Set(sessions.map((session) => session.id)),
    addSession: vi.fn(),
    closeSession: vi.fn(),
    setActiveSession: vi.fn(),
    markSessionInitialized: vi.fn(),
    updateSessionInfo: vi.fn(),
    renameSession: vi.fn(),
  };
}

describe("TerminalCore resource lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    terminalMounted.mockClear();
    terminalUnmounted.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  function render(activeSessionId: string, visible: boolean) {
    act(() => {
      root.render(
        createElement(TerminalCore, {
          terminalState: createTerminalState(activeSessionId),
          visible,
        })
      );
    });
  }

  it("mounts at most the active visible terminal and releases it on switch or hide", () => {
    render("terminal-a", true);

    expect(
      container.querySelector('[data-terminal-session="terminal-a"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-terminal-session="terminal-b"]')
    ).toBeNull();
    expect(terminalMounted).toHaveBeenCalledWith("terminal-a");

    render("terminal-b", true);

    expect(terminalUnmounted).toHaveBeenCalledWith("terminal-a");
    expect(
      container.querySelector('[data-terminal-session="terminal-a"]')
    ).toBeNull();
    expect(
      container.querySelector('[data-terminal-session="terminal-b"]')
    ).not.toBeNull();

    render("terminal-b", false);

    expect(terminalUnmounted).toHaveBeenCalledWith("terminal-b");
    expect(container.querySelector("[data-terminal-session]")).toBeNull();

    render("terminal-b", true);

    expect(
      container.querySelector('[data-terminal-session="terminal-b"]')
    ).not.toBeNull();
    expect(terminalMounted).toHaveBeenCalledTimes(3);
  });
});
