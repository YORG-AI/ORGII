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

import { useAgentConfigBase } from "./useAgentConfigBase";

const undoStack = vi.hoisted(() => ({ snapshot: vi.fn() }));

vi.mock("@src/components/Message", () => ({
  default: { error: vi.fn() },
}));
vi.mock("@src/hooks/ui", () => ({
  useUndoStackWithRestore: () => undoStack,
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

function ConfigProbe({
  load,
  save,
}: {
  load: () => Promise<Record<string, unknown>>;
  save: (config: Record<string, unknown>) => Promise<void>;
}) {
  const state = useAgentConfigBase({ load, save });
  return createElement("output", {
    "data-loaded": String(state.loaded),
    "data-value": String(state.config.value ?? ""),
  });
}

describe("useAgentConfigBase load scope", () => {
  let container: HTMLDivElement;
  let root: Root;
  const save = vi.fn().mockResolvedValue(undefined);
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  function renderProbe(
    load: () => Promise<Record<string, unknown>>,
    persist = save
  ) {
    act(() => {
      root.render(createElement(ConfigProbe, { load, save: persist }));
    });
  }

  it("loads once per callback identity and ignores the superseded scope", async () => {
    const scopeA = deferred<Record<string, unknown>>();
    const scopeB = deferred<Record<string, unknown>>();
    const loadA = vi.fn(() => scopeA.promise);
    const loadB = vi.fn(() => scopeB.promise);

    renderProbe(loadA);
    expect(loadA).toHaveBeenCalledTimes(1);

    renderProbe(loadA);
    expect(loadA).toHaveBeenCalledTimes(1);

    renderProbe(loadB);
    expect(loadB).toHaveBeenCalledTimes(1);

    await act(async () => {
      scopeB.resolve({ value: "scope-b" });
      await scopeB.promise;
    });
    expect(container.querySelector("output")?.getAttribute("data-value")).toBe(
      "scope-b"
    );

    await act(async () => {
      scopeA.resolve({ value: "stale-scope-a" });
      await scopeA.promise;
    });
    expect(container.querySelector("output")?.getAttribute("data-value")).toBe(
      "scope-b"
    );
  });
});
