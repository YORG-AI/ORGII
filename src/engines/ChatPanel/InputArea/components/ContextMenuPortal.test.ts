// @vitest-environment jsdom
import React, { act } from "react";
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

import ContextMenuPortal from "./ContextMenuPortal";

const mocks = vi.hoisted(() => ({
  contextMenu: vi.fn(),
  workItemPicker: vi.fn(),
}));

vi.mock("@/src/scaffold/ContextMenu/exports", () => ({
  ContextMenu: (props: unknown) => {
    mocks.contextMenu(props);
    return React.createElement("div", { "data-testid": "context-menu" });
  },
}));

vi.mock("@src/features/SessionCreator/components/WorkItemPickerModal", () => ({
  default: (props: unknown) => {
    mocks.workItemPicker(props);
    return null;
  },
}));

vi.mock("./pathTreePosition", () => ({
  usePathTreePosition: () => "right",
}));

vi.mock("./useFloatingPortalPosition", () => ({
  useFloatingPortalPosition: () => ({
    portalPosition: { placement: "up", bottom: 20, left: 20 },
    portalWidth: 400,
    isPositioned: true,
  }),
}));

interface CapturedContextMenuProps {
  onSelect: (type: string, value?: string, displayName?: string) => void;
}

interface CapturedWorkItemPickerProps {
  open: boolean;
  onSelect: (
    options: ReadonlyArray<{
      kind: "workitem";
      pillPath: string;
      pillName: string;
    }>
  ) => void;
  sourceFilters: string[];
}

describe("ContextMenuPortal Work Item command", () => {
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  let previousActEnvironment: boolean | undefined;
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
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

  it("opens the local Work Item spotlight and forwards its selection", () => {
    const onSelect = vi.fn();
    const props = {
      visible: true,
      containerRef: { current: container },
      onClose: vi.fn(),
      onSelect,
      currentMode: "build" as const,
      onModeSelect: vi.fn(),
      searchQuery: "",
      repoPath: "/workspace/repo",
      keyboardHandlerRef: { current: null },
    };

    act(() => root.render(React.createElement(ContextMenuPortal, props)));

    const contextMenuProps = mocks.contextMenu.mock.calls.at(-1)?.[0] as
      | CapturedContextMenuProps
      | undefined;
    act(() => contextMenuProps?.onSelect("projects"));

    expect(onSelect).not.toHaveBeenCalled();
    expect(mocks.workItemPicker.mock.calls.at(-1)?.[0]).toMatchObject({
      open: true,
      multiple: false,
      repoPath: "/workspace/repo",
      sourceFilters: ["workitem"],
    });

    act(() =>
      root.render(
        React.createElement(ContextMenuPortal, { ...props, visible: false })
      )
    );
    const pickerProps = mocks.workItemPicker.mock.calls.at(-1)?.[0] as
      | CapturedWorkItemPickerProps
      | undefined;
    expect(pickerProps?.open).toBe(true);

    act(() =>
      pickerProps?.onSelect([
        {
          kind: "workitem",
          pillPath: "orgii/ORG-12",
          pillName: "#ORG-12 Spotlight picker",
        },
      ])
    );

    expect(onSelect).toHaveBeenCalledWith(
      "workitem",
      "orgii/ORG-12",
      "#ORG-12 Spotlight picker"
    );
    expect(mocks.workItemPicker.mock.calls.at(-1)?.[0]).toMatchObject({
      open: false,
    });
  });

  it("forwards non-Work-Item menu selections unchanged", () => {
    const onSelect = vi.fn();

    act(() =>
      root.render(
        React.createElement(ContextMenuPortal, {
          visible: true,
          containerRef: { current: container },
          onClose: vi.fn(),
          onSelect,
          currentMode: "build",
          onModeSelect: vi.fn(),
          searchQuery: "",
          keyboardHandlerRef: { current: null },
        })
      )
    );

    const contextMenuProps = mocks.contextMenu.mock.calls.at(-1)?.[0] as
      | CapturedContextMenuProps
      | undefined;
    act(() => contextMenuProps?.onSelect("files", "/tmp/a.ts", "a.ts"));

    expect(onSelect).toHaveBeenCalledWith("files", "/tmp/a.ts", "a.ts");
    expect(mocks.workItemPicker.mock.calls.at(-1)?.[0]).toMatchObject({
      open: false,
    });
  });
});
