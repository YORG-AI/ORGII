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

import { useOSAgentConfig } from "./useOSAgentConfig";

const mocks = vi.hoisted(() => ({
  baseState: {
    config: { model: "model-a" } as Record<string, unknown>,
    loaded: true,
    saveConfig: vi.fn(),
    updateWithUndo: vi.fn(),
  },
  checkKeys: vi.fn(),
  getAgentConfig: vi.fn(),
  updateAgentConfig: vi.fn(),
}));

vi.mock("@src/api/tauri/agent", () => ({
  checkKeys: mocks.checkKeys,
  getAgentConfig: mocks.getAgentConfig,
  updateAgentConfig: mocks.updateAgentConfig,
}));
vi.mock("./useAgentConfigBase", () => ({
  useAgentConfigBase: () => mocks.baseState,
}));

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function CredentialProbe() {
  const state = useOSAgentConfig();
  return createElement("output", {
    "data-provider": state.credStatus?.provider ?? "",
  });
}

describe("useOSAgentConfig credential synchronization", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.baseState.config = { model: "model-a" };
    mocks.baseState.loaded = true;
    mocks.checkKeys.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  function renderProbe() {
    act(() => {
      root.render(createElement(CredentialProbe));
    });
  }

  function flushDebounce() {
    act(() => {
      vi.advanceTimersByTime(300);
    });
  }

  it("checks only when the current model changes", () => {
    mocks.checkKeys.mockImplementation(() => new Promise(() => {}));

    renderProbe();
    flushDebounce();
    expect(mocks.checkKeys).toHaveBeenLastCalledWith("model-a");

    mocks.baseState.config = { model: "model-a", temperature: 0.4 };
    renderProbe();
    flushDebounce();
    expect(mocks.checkKeys).toHaveBeenCalledTimes(1);

    mocks.baseState.config = { model: "model-b" };
    renderProbe();
    flushDebounce();
    expect(mocks.checkKeys).toHaveBeenLastCalledWith("model-b");
    expect(mocks.checkKeys).toHaveBeenCalledTimes(2);
  });

  it("ignores a stale credential response after the model changes", async () => {
    const modelA = deferred<{ found: boolean; provider: string }>();
    const modelB = deferred<{ found: boolean; provider: string }>();
    mocks.checkKeys.mockImplementation((model: string) =>
      model === "model-a" ? modelA.promise : modelB.promise
    );

    renderProbe();
    flushDebounce();

    mocks.baseState.config = { model: "model-b" };
    renderProbe();
    flushDebounce();

    await act(async () => {
      modelB.resolve({ found: true, provider: "provider-b" });
      await modelB.promise;
    });
    expect(
      container.querySelector("output")?.getAttribute("data-provider")
    ).toBe("provider-b");

    await act(async () => {
      modelA.resolve({ found: true, provider: "stale-provider-a" });
      await modelA.promise;
    });
    expect(
      container.querySelector("output")?.getAttribute("data-provider")
    ).toBe("provider-b");
  });
});
