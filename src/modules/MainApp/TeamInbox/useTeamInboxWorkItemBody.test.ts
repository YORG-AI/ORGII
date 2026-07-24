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

import type { WorkItemTarget } from "./domain";
import { useTeamInboxWorkItemBody } from "./useTeamInboxWorkItemBody";

const mocks = vi.hoisted(() => ({
  readWorkItem: vi.fn(),
}));

vi.mock("@src/api/http/project", () => ({
  projectApi: {
    readWorkItem: mocks.readWorkItem,
    readStandaloneWorkItem: vi.fn(),
  },
}));

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

const Harness = ({ target }: { target: WorkItemTarget }) => {
  const state = useTeamInboxWorkItemBody(target);
  return createElement("output", {
    "data-body": state.body ?? "",
    "data-loading": String(state.loading),
  });
};

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("useTeamInboxWorkItemBody", () => {
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
    vi.clearAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("shows loading for a new target and discards the stale response", async () => {
    const first = deferred<{ body: string }>();
    const second = deferred<{ body: string }>();
    mocks.readWorkItem
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    await act(async () => {
      root.render(
        createElement(Harness, {
          target: {
            kind: "work_item",
            projectId: "project-a",
            workItemId: "item-a",
          },
        })
      );
    });
    expect(container.querySelector("output")?.dataset.loading).toBe("true");

    await act(async () => {
      root.render(
        createElement(Harness, {
          target: {
            kind: "work_item",
            projectId: "project-b",
            workItemId: "item-b",
          },
        })
      );
    });
    expect(container.querySelector("output")?.dataset.loading).toBe("true");

    await act(async () => {
      first.resolve({ body: "stale body" });
      await first.promise;
    });
    expect(container.querySelector("output")?.dataset.loading).toBe("true");
    expect(container.querySelector("output")?.dataset.body).toBe("");

    await act(async () => {
      second.resolve({ body: "current body" });
      await second.promise;
    });
    expect(container.querySelector("output")?.dataset.loading).toBe("false");
    expect(container.querySelector("output")?.dataset.body).toBe(
      "current body"
    );
  });
});
