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

import TerminalBlock from ".";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@src/engines/ChatPanel/hooks/useChatEventReplay", () => ({
  useChatEventReplay: () => ({
    replayEventById: vi.fn(),
    canReplay: false,
  }),
}));

vi.mock("@src/engines/ChatPanel/blocks/primitives/useStrokeDraw", () => ({
  useStrokeDraw: () => () => undefined,
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("TerminalBlock collapse policy", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  function renderTerminal(props: {
    exitCode?: number;
    isError?: boolean;
    isLoading?: boolean;
  }) {
    act(() => {
      root.render(
        createElement(TerminalBlock, {
          command: "gh pr checks 964",
          title: props.isLoading ? "Running command" : "Ran command",
          ...props,
        })
      );
    });
  }

  function commandBody(): Element | null {
    return container.querySelector(".terminal-command__text");
  }

  it("keeps a historical failed command collapsed inside its group", () => {
    renderTerminal({ exitCode: 8, isError: true });

    expect(container.textContent).toContain("exit 8");
    expect(commandBody()).toBeNull();
  });

  it("keeps a running command expanded", () => {
    renderTerminal({ isLoading: true });

    expect(commandBody()?.textContent).toBe("gh pr checks 964");
  });

  it("collapses a live command when it settles as failed", () => {
    renderTerminal({ isLoading: true });
    expect(commandBody()).not.toBeNull();

    renderTerminal({ exitCode: 8, isError: true });

    expect(container.textContent).toContain("exit 8");
    expect(commandBody()).toBeNull();
  });
});
