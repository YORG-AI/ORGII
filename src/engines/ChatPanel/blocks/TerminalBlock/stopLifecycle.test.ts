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

import { TerminalStopButton } from ".";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("TerminalBlock stop lifecycle", () => {
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

  function render(onStop: (pid: number) => void) {
    act(() => {
      root.render(
        createElement(TerminalStopButton, {
          pid: 42,
          onStop,
          title: "common:actions.stop",
        })
      );
    });
  }

  it("resets a stop request when the stoppable run ends and restarts", () => {
    const onStop = vi.fn();
    render(onStop);

    const firstButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="common:actions.stop"]'
    );
    act(() => firstButton?.click());
    expect(onStop).toHaveBeenCalledWith(42);
    expect(firstButton?.disabled).toBe(true);

    act(() => root.render(null));
    expect(
      container.querySelector('[aria-label="common:actions.stop"]')
    ).toBeNull();

    render(onStop);
    const restartedButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="common:actions.stop"]'
    );
    expect(restartedButton?.disabled).toBe(false);
  });
});
