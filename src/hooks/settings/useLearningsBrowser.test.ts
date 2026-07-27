// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
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

import type { LearningRecord } from "@src/api/tauri/rpc/schemas/learning";

import {
  type UseLearningsBrowserReturn,
  useLearningsBrowser,
} from "./useLearningsBrowser";

const learningMocks = vi.hoisted(() => ({
  browseList: vi.fn(),
  getStatus: vi.fn(),
  remove: vi.fn(),
  setStatus: vi.fn(),
}));

vi.mock("@src/api/tauri/rpc", () => ({
  rpc: {
    learning: learningMocks,
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("useLearningsBrowser", () => {
  let container: HTMLDivElement;
  let root: Root;
  let current: UseLearningsBrowserReturn;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  function Harness() {
    const result = useLearningsBrowser();
    useEffect(() => {
      current = result;
    }, [result]);
    return createElement("div", {
      "data-item": result.items[0]?.id ?? "",
      "data-loading": String(result.loading),
    });
  }

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    learningMocks.browseList.mockReset();
    learningMocks.getStatus.mockReset();
    learningMocks.remove.mockReset();
    learningMocks.setStatus.mockReset();
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

  it("keeps the newest filter result when an older request finishes last", async () => {
    const oldList = deferred<LearningRecord[]>();
    const oldStatus = deferred<never>();
    const newList = deferred<LearningRecord[]>();
    const newStatus = deferred<never>();
    learningMocks.browseList
      .mockReturnValueOnce(oldList.promise)
      .mockReturnValueOnce(newList.promise);
    learningMocks.getStatus
      .mockReturnValueOnce(oldStatus.promise)
      .mockReturnValueOnce(newStatus.promise);

    act(() => root.render(createElement(Harness)));
    act(() => current.setFilters({ search: "new" }));

    newList.resolve([
      { id: "new", updated_at: "2026-07-23T10:00:00Z" } as LearningRecord,
    ]);
    newStatus.resolve({} as never);
    await flush();
    expect(container.firstElementChild?.getAttribute("data-item")).toBe("new");

    oldList.resolve([
      { id: "old", updated_at: "2026-07-22T10:00:00Z" } as LearningRecord,
    ]);
    oldStatus.resolve({} as never);
    await flush();

    expect(container.firstElementChild?.getAttribute("data-item")).toBe("new");
    expect(learningMocks.browseList).toHaveBeenCalledTimes(2);
  });
});
