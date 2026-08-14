// @vitest-environment jsdom
import type { UseTerminalStateReturn } from "@/src/engines/TerminalCore/types";
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

import TerminalMainContent from "../index";

const { readOnlyMounted, readOnlyUnmounted } = vi.hoisted(() => ({
  readOnlyMounted: vi.fn(),
  readOnlyUnmounted: vi.fn(),
}));

vi.mock("jotai", () => ({
  useAtomValue: () => ({ kind: "agent", sessionId: "agent-a" }),
  useSetAtom: () => vi.fn(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("lucide-react", () => ({ Trash2: () => null }));
vi.mock("@src/components/Button", () => ({ default: () => null }));
vi.mock("@src/modules/WorkStation/shared", () => ({
  FileHeader: () => null,
  TerminalInfoButton: () => null,
  TerminalNewSessionSplitButton: () => null,
}));
vi.mock("@src/modules/shared/layouts/blocks", () => ({
  Placeholder: () => null,
}));
vi.mock("@src/store/workstation/codeEditor", () => ({
  clearTerminalTargetReferencesAtom: {},
  codeEditorTerminalTargetAtom: {},
}));
vi.mock("../restorePtySelection", () => ({
  resolveRestoredPtySessionId: () => null,
}));
vi.mock("@/src/engines/TerminalCore/exports", async () => {
  const React = await import("react");
  return {
    default: () =>
      React.createElement("div", { "data-interactive-terminal": true }),
    getTerminalDisplayTitle: (session: { name: string }) => session.name,
  };
});
vi.mock("@src/components/TerminalReadOnly", async () => {
  const React = await import("react");
  function MockTerminalReadOnly({
    agentSessionId,
  }: {
    agentSessionId: string;
  }) {
    React.useEffect(() => {
      readOnlyMounted(agentSessionId);
      return () => readOnlyUnmounted(agentSessionId);
    }, [agentSessionId]);
    return React.createElement("div", {
      "data-read-only-terminal": agentSessionId,
    });
  }
  return {
    default: MockTerminalReadOnly,
  };
});

function createTerminalState(): UseTerminalStateReturn {
  const session = { id: "pty-a", name: "Terminal A", isActive: true };
  return {
    sessions: [session],
    activeSessionId: session.id,
    activeSession: session,
    initializedSessions: new Set([session.id]),
    addSession: vi.fn(),
    closeSession: vi.fn(),
    setActiveSession: vi.fn(),
    markSessionInitialized: vi.fn(),
    updateSessionInfo: vi.fn(),
    renameSession: vi.fn(),
  };
}

describe("TerminalMainContent resource lifecycle", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    readOnlyMounted.mockClear();
    readOnlyUnmounted.mockClear();
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

  async function render(visible: boolean) {
    await act(async () => {
      root.render(
        createElement(TerminalMainContent, {
          terminalState: createTerminalState(),
          visible,
        })
      );
      await Promise.resolve();
    });
  }

  it("releases the read-only agent xterm while the terminal host is hidden", async () => {
    await render(true);

    expect(
      container.querySelector('[data-read-only-terminal="agent-a"]')
    ).not.toBeNull();
    expect(readOnlyMounted).toHaveBeenCalledWith("agent-a");

    await render(false);

    expect(container.querySelector("[data-read-only-terminal]")).toBeNull();
    expect(readOnlyUnmounted).toHaveBeenCalledWith("agent-a");

    await render(true);

    expect(
      container.querySelector('[data-read-only-terminal="agent-a"]')
    ).not.toBeNull();
    expect(readOnlyMounted).toHaveBeenCalledTimes(2);
  });
});
