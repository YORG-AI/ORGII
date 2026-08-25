// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
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

import type { WorkspacePort } from "@src/api/tauri/workspacePorts";
import { workspacePortsStateAtom } from "@src/store/workstation/codeEditor/workspacePortsAtom";

import BlankTabPortOptions, {
  BLANK_TAB_PORT_OPTION_LIMIT,
} from "./BlankTabPortOptions";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { pid?: number }) =>
      values?.pid == null ? key : `${key}:${values.pid}`,
  }),
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

function createPort(
  port: number,
  kind: WorkspacePort["kind"] = "workspace"
): WorkspacePort {
  return {
    id: `${kind}-${port}`,
    bindHost: "0.0.0.0",
    connectHost: "localhost",
    port,
    pid: port,
    processName: `process-${port}`,
    protocol: "http",
    kind,
    owner:
      kind === "workspace"
        ? {
            folderId: "folder-1",
            repoId: "repo-1",
            displayName: "ORGII",
            path: "/workspace/orgii",
            confidence: "cwd",
          }
        : undefined,
  };
}

describe("BlankTabPortOptions", () => {
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

  it("shows a bounded cached workspace-port list and opens the selected URL", () => {
    const store = createStore();
    const workspacePorts = Array.from(
      { length: BLANK_TAB_PORT_OPTION_LIMIT + 2 },
      (_, index) => createPort(1998 + index)
    );
    store.set(workspacePortsStateAtom, {
      result: {
        platform: "test",
        scannedAt: 1,
        ports: [...workspacePorts, createPort(5432, "external")],
      },
      refreshing: false,
      lastScanStartedAt: 1,
    });
    const onOpen = vi.fn();

    act(() => {
      root.render(
        createElement(
          Provider,
          { store },
          createElement(BlankTabPortOptions, { onOpen })
        )
      );
    });

    const options = container.querySelectorAll("button");
    expect(options).toHaveLength(BLANK_TAB_PORT_OPTION_LIMIT);
    expect(container.textContent).not.toContain("5432");

    act(() => options[0].click());
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith("http://localhost:1998/");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
