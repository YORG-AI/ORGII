// @vitest-environment jsdom
import { StrictMode, act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";

import { useOAuthBrowserAutoStart } from "./useOAuthBrowserAutoStart";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

interface HarnessProps {
  showBrowser: boolean;
  startLogin: () => Promise<void>;
}

const Harness = ({ showBrowser, startLogin }: HarnessProps) => {
  useOAuthBrowserAutoStart(showBrowser, startLogin);
  return null;
};

const renderHarness = (props: HarnessProps) =>
  createElement(StrictMode, null, createElement(Harness, props));

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.clearAllMocks();
});

afterAll(() => {
  Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
});

it("starts at most one PKCE attempt for each browser open", async () => {
  const firstStart = vi.fn(() => Promise.resolve());
  const replacementStart = vi.fn(() => Promise.resolve());

  await act(async () => {
    root.render(renderHarness({ showBrowser: true, startLogin: firstStart }));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  expect(firstStart).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);

  await act(async () => {
    root.render(
      renderHarness({
        showBrowser: true,
        startLogin: replacementStart,
      })
    );
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(replacementStart).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);

  await act(async () => {
    root.render(
      renderHarness({
        showBrowser: false,
        startLogin: replacementStart,
      })
    );
  });
  await act(async () => {
    root.render(
      renderHarness({
        showBrowser: true,
        startLogin: replacementStart,
      })
    );
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  expect(replacementStart).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
