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

import WorkItemAttachmentControl from "./WorkItemAttachmentControl";

const dropdownMocks = vi.hoisted(() => ({
  close: vi.fn(),
  toggle: vi.fn(),
}));

const projectApiMocks = vi.hoisted(() => ({
  readProjects: vi.fn().mockResolvedValue([]),
  readStandaloneWorkItems: vi.fn().mockResolvedValue([]),
  readWorkItems: vi.fn().mockResolvedValue([]),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@src/hooks/dropdown", () => ({
  useDropdownEngine: () => ({
    close: dropdownMocks.close,
    isOpen: true,
    isPositioned: true,
    panelPosition: { left: 0, top: 0 },
    panelRef: { current: null },
    toggle: dropdownMocks.toggle,
    triggerRef: { current: null },
  }),
}));

vi.mock("@src/api/http/project", () => ({
  projectApi: projectApiMocks,
}));

describe("WorkItemAttachmentControl", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    dropdownMocks.close.mockClear();
    dropdownMocks.toggle.mockClear();
    projectApiMocks.readProjects.mockClear();
    projectApiMocks.readStandaloneWorkItems.mockClear();
    projectApiMocks.readWorkItems.mockClear();
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

  it("navigates directly to the Work Item creator when provided", () => {
    const onCreateWorkItem = vi.fn();
    act(() => {
      root.render(
        createElement(WorkItemAttachmentControl, { onCreateWorkItem })
      );
    });

    const trigger = container.querySelector(
      '[data-testid="session-creator-work-item-toggle"]'
    );
    expect(trigger?.getAttribute("aria-haspopup")).toBeNull();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(
      document.querySelector('[data-testid="work-item-create-inline-panel"]')
    ).toBeNull();

    act(() => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onCreateWorkItem).toHaveBeenCalledOnce();
    expect(dropdownMocks.toggle).not.toHaveBeenCalled();
  });

  it("retains the live link-existing flow without exposing inline creation", async () => {
    act(() => {
      root.render(createElement(WorkItemAttachmentControl));
    });

    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    expect(document.body.textContent).toContain("common:actions.link");
    expect(document.body.textContent).not.toContain("common:actions.create");
    expect(
      document.querySelector('[data-testid="work-item-create-inline-panel"]')
    ).toBeNull();

    const linkAction = Array.from(
      document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
    ).find((element) => element.textContent?.includes("common:actions.link"));

    await act(async () => {
      linkAction?.click();
      await Promise.resolve();
    });

    expect(dropdownMocks.close).toHaveBeenCalledOnce();
    expect(projectApiMocks.readProjects).toHaveBeenCalledOnce();
    expect(projectApiMocks.readStandaloneWorkItems).toHaveBeenCalledOnce();
    expect(
      document.querySelector('[data-testid="work-item-link-inline-panel"]')
    ).not.toBeNull();
  });
});
