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

import type { WorkspaceMemoryEntry } from "@src/api/tauri/rpc/schemas/workspaceMemory";

import {
  MEMORY_SORT_NEWEST,
  type UseWorkspaceMemoryDataOptions,
  type UseWorkspaceMemoryDataReturn,
  useWorkspaceMemoryData,
} from "./useWorkspaceMemoryData";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  t: (key: string) => key,
}));

vi.mock("@src/api/tauri/rpc", () => ({
  rpc: {
    workspaceMemory: {
      list: mocks.list,
      read: vi.fn(),
      index: vi.fn(),
      delete: vi.fn(),
      clear: vi.fn(),
    },
  },
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn() }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}));
vi.mock("@src/components/Message", () => ({
  default: { error: vi.fn(), success: vi.fn() },
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function Probe({
  options,
  onValue,
}: {
  options: UseWorkspaceMemoryDataOptions;
  onValue: (value: UseWorkspaceMemoryDataReturn) => void;
}) {
  onValue(useWorkspaceMemoryData(options));
  return null;
}

describe("useWorkspaceMemoryData", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: UseWorkspaceMemoryDataReturn;

  const entry = (filename: string): WorkspaceMemoryEntry =>
    ({ filename, mtimeMs: 1, ageDisplay: "now" }) as WorkspaceMemoryEntry;

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

  function render(workspace: string) {
    const options: UseWorkspaceMemoryDataOptions = {
      workspace,
      searchQuery: "",
      sortKey: MEMORY_SORT_NEWEST,
      typeFilter: "all",
      onRefreshStatus: vi.fn(),
    };
    act(() => {
      root.render(
        createElement(Probe, {
          options,
          onValue: (value) => (latest = value),
        })
      );
    });
  }

  it("resets on workspace change and rejects a stale list completion", async () => {
    const workspaceA = deferred<WorkspaceMemoryEntry[]>();
    const workspaceB = deferred<WorkspaceMemoryEntry[]>();
    mocks.list
      .mockReturnValueOnce(workspaceA.promise)
      .mockReturnValueOnce(workspaceB.promise);

    render("/repo/a");
    expect(latest.loading).toBe(true);
    render("/repo/b");
    expect(latest.files).toEqual([]);
    expect(latest.loading).toBe(true);

    await act(async () => workspaceA.resolve([entry("from-a.md")]));
    expect(latest.files).toEqual([]);
    expect(latest.loading).toBe(true);

    await act(async () => workspaceB.resolve([entry("from-b.md")]));
    expect(latest.files.map((file) => file.filename)).toEqual(["from-b.md"]);
    expect(latest.loading).toBe(false);
  });
});
