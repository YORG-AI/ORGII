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

import { useSdeAgentConfig } from "./useSdeAgentConfig";

const mocks = vi.hoisted(() => ({
  getAgentConfig: vi.fn(),
  updateAgentConfig: vi.fn().mockResolvedValue(undefined),
  undoStack: { snapshot: vi.fn() },
}));

vi.mock("@src/api/tauri/agent", () => ({
  getAgentConfig: mocks.getAgentConfig,
  updateAgentConfig: mocks.updateAgentConfig,
}));
vi.mock("@src/components/Message", () => ({
  default: { error: vi.fn() },
}));
vi.mock("@src/hooks/ui", () => ({
  useUndoStackWithRestore: () => mocks.undoStack,
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

function SdeConfigProbe({ workspacePath }: { workspacePath: string }) {
  const state = useSdeAgentConfig(workspacePath);
  return createElement(
    "div",
    null,
    createElement("output", {
      "data-value": String(state.config.value ?? ""),
    }),
    createElement(
      "button",
      { onClick: () => state.update("value", "edited-workspace-b") },
      "Edit"
    )
  );
}

describe("useSdeAgentConfig dependency scope", () => {
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
    mocks.getAgentConfig.mockReset();
    mocks.updateAgentConfig.mockClear();
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

  function renderProbe(workspacePath: string) {
    act(() => {
      root.render(createElement(SdeConfigProbe, { workspacePath }));
    });
  }

  it("reloads once for a new workspace and ignores the old response", async () => {
    const workspaceA = deferred<Record<string, unknown>>();
    const workspaceB = deferred<Record<string, unknown>>();
    mocks.getAgentConfig.mockImplementation(
      (_agentType: string, workspacePath: string) =>
        workspacePath === "/workspace/a"
          ? workspaceA.promise
          : workspaceB.promise
    );

    renderProbe("/workspace/a");
    expect(mocks.getAgentConfig).toHaveBeenCalledTimes(1);

    renderProbe("/workspace/a");
    expect(mocks.getAgentConfig).toHaveBeenCalledTimes(1);

    renderProbe("/workspace/b");
    expect(mocks.getAgentConfig).toHaveBeenCalledTimes(2);
    expect(mocks.getAgentConfig.mock.calls[1]?.[1]).toBe("/workspace/b");

    await act(async () => {
      workspaceB.resolve({ value: "workspace-b" });
      await workspaceB.promise;
    });
    expect(container.querySelector("output")?.getAttribute("data-value")).toBe(
      "workspace-b"
    );

    await act(async () => {
      workspaceA.resolve({ value: "stale-workspace-a" });
      await workspaceA.promise;
    });
    expect(container.querySelector("output")?.getAttribute("data-value")).toBe(
      "workspace-b"
    );

    act(() => container.querySelector("button")?.click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(mocks.updateAgentConfig).toHaveBeenCalledWith(
      expect.anything(),
      { value: "edited-workspace-b" },
      "/workspace/b"
    );
  });
});
