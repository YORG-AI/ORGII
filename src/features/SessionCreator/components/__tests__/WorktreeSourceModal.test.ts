// @vitest-environment jsdom
import React, { act, createElement } from "react";
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

import type Modal from "@src/scaffold/ModalSystem";

import WorktreeSourceModal from "../WorktreeSourceModal";
import { WorktreeSourceRow } from "../WorktreeSourceModalRows";

const testState = vi.hoisted(() => ({
  modalProps: null as React.ComponentProps<typeof Modal> | null,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      key === "common:actions.cancel"
        ? "Cancel"
        : key === "common:actions.create"
          ? "Create"
          : (options?.defaultValue ?? key),
  }),
}));

// SVGs resolve to URL strings in Vitest, outside the webpack SVGR pipeline.
vi.mock("@src/assets/channelIcons/github.svg", () => ({
  default: (props: React.SVGProps<SVGSVGElement>) =>
    createElement("svg", { ...props, "data-testid": "github-icon" }),
}));

vi.mock("@src/scaffold/ModalSystem", async () => {
  const ReactModule = await import("react");
  return {
    default: (props: React.ComponentProps<typeof Modal>) => {
      testState.modalProps = props;
      return ReactModule.createElement(
        "div",
        { "data-testid": "modal" },
        props.children
      );
    },
  };
});

vi.mock(
  "@src/scaffold/GlobalSpotlight/palettes/BranchPalette/useWorktreeMap",
  () => ({ useWorktreeMap: () => new Map() })
);

vi.mock("../useWorktreeSourceData", () => ({
  useWorktreeSourceData: () => ({
    github: {
      prs: [],
      issues: [],
      state: "empty",
      error: null,
      repoFullName: null,
      refreshing: false,
      refresh: vi.fn(),
    },
    branch: {
      options: [],
      state: "empty",
      error: null,
      refreshing: false,
      refresh: vi.fn(),
    },
  }),
}));

describe("WorktreeSourceModal", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    testState.modalProps = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root.render(
        createElement(WorktreeSourceModal, {
          open: true,
          repoId: "repo-a",
          repoPath: "/repo/a",
          branchName: "develop",
          onClose: vi.fn(),
          onSelect: vi.fn(),
        })
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("uses the standard large modal action props", () => {
    expect(testState.modalProps).toMatchObject({
      visible: true,
      title: "Create worktree",
      size: "large",
      bodyClassName: "p-0",
      okText: "Create",
      cancelText: "Cancel",
      okButtonProps: { disabled: false, loading: false },
      cancelButtonProps: { disabled: false },
      closable: true,
      maskClosable: true,
      escToExit: true,
    });
    expect(testState.modalProps?.onOk).toEqual(expect.any(Function));
    expect(testState.modalProps?.onCancel).toEqual(expect.any(Function));
    expect(testState.modalProps).not.toHaveProperty("width");
    expect(testState.modalProps).not.toHaveProperty("radius");
    expect(testState.modalProps).not.toHaveProperty("footer");
  });

  it("uses the work-item picker tab treatment", () => {
    const tabList = container.querySelector<HTMLElement>("[role='tablist']");
    const tabs = [...container.querySelectorAll<HTMLElement>("[role='tab']")];

    expect(tabList?.className).toContain("pt-1");
    expect(tabList?.className).not.toContain("pt-3");
    expect(tabs).toHaveLength(2);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[0]?.textContent).toContain("Branch");
    expect(tabs[0]?.className).toContain("rounded-t-md");
    expect(tabs[0]?.className).toContain("border-border-2");
    expect(tabs[1]?.className).toContain("hover:bg-fill-1");
    expect(
      tabs[1]?.querySelector("[data-testid='github-icon']")
    ).not.toBeNull();
  });

  it("keeps source rows compact and full width", () => {
    act(() => {
      root.render(
        createElement(WorktreeSourceRow, {
          icon: createElement("span", null, "I"),
          title: "develop",
          selected: false,
          onClick: vi.fn(),
        })
      );
    });

    const row = container.querySelector("button");
    expect(row?.className).toContain("min-h-8");
    expect(row?.className).toContain("w-full");
    expect(row?.className).toContain("!py-1");
  });
});
