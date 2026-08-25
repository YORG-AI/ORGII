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
import {
  workStationBrowserSidebarCollapsedAtom,
  workStationBrowserSidebarCollapsedPersistAtom,
} from "@src/store/ui/workStationAtom";
import { workspacePortsStateAtom } from "@src/store/workstation/codeEditor/workspacePortsAtom";

import BrowserBlankTabPlaceholder from "./BrowserBlankTabPlaceholder";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@src/modules/WorkStation/shared", () => ({
  NoTabsPlaceholder: ({
    icon,
    caption,
    actions,
    children,
  }: {
    icon: string;
    caption?: string;
    actions?: Array<{
      id: string;
      label: string;
      shortcut?: string;
      onAction?: () => void;
    }>;
    children?: React.ReactNode;
  }) =>
    createElement(
      "div",
      { "data-placeholder-icon": icon, "data-caption": caption },
      actions?.map((action) =>
        createElement(
          "button",
          {
            key: action.id,
            type: "button",
            "data-action-id": action.id,
            "data-shortcut": action.shortcut,
            onClick: action.onAction,
          },
          action.label
        )
      ),
      children
    ),
}));

vi.mock(
  "@src/modules/WorkStation/shared/StatusBar/WorkspacePortScanner",
  () => ({
    WorkspacePortScanner: ({ enabled }: { enabled: boolean }) =>
      createElement("span", {
        "data-testid": "workspace-port-scanner",
        "data-enabled": String(enabled),
      }),
  })
);

function createWorkspacePort(): WorkspacePort {
  return {
    id: "workspace-1998",
    bindHost: "0.0.0.0",
    connectHost: "localhost",
    port: 1998,
    pid: 1998,
    processName: "node",
    protocol: "http",
    kind: "workspace",
    owner: {
      folderId: "folder-1",
      repoId: "repo-1",
      displayName: "ORGII",
      path: "/workspace/orgii",
      confidence: "cwd",
    },
  };
}

describe("BrowserBlankTabPlaceholder", () => {
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

  it("shows the browser sidebar shortcut and cached scanned ports", () => {
    const store = createStore();
    store.set(workStationBrowserSidebarCollapsedPersistAtom, false);
    store.set(workspacePortsStateAtom, {
      result: {
        platform: "test",
        scannedAt: 1,
        ports: [createWorkspacePort()],
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
          createElement(BrowserBlankTabPlaceholder, { onOpen })
        )
      );
    });

    expect(
      container
        .querySelector('[data-testid="workspace-port-scanner"]')
        ?.getAttribute("data-enabled")
    ).toBe("true");
    expect(container.querySelector('[data-placeholder-icon="browser"]')).not
      .toBeNull;

    const sidebarAction = container.querySelector<HTMLButtonElement>(
      '[data-action-id="toggle-browser-sidebar"]'
    );
    expect(sidebarAction?.textContent).toBe("commands.hidePrimarySidebar");
    expect(sidebarAction?.dataset.shortcut).toBeTruthy();

    act(() => sidebarAction?.click());
    expect(store.get(workStationBrowserSidebarCollapsedAtom)).toBe(true);

    const portAction = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("1998")
    );
    act(() => portAction?.click());
    expect(onOpen).toHaveBeenCalledWith("http://localhost:1998/");
  });
});
