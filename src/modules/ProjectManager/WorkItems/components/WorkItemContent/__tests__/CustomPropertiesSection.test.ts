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

import CustomPropertiesSection from "../CustomPropertiesSection";

const projectApiMocks = vi.hoisted(() => ({
  listPropertyDefinitions: vi.fn(),
  listWorkItemPropertyValues: vi.fn(),
}));

vi.mock("@src/api/http/project", () => ({
  projectApi: projectApiMocks,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
  }),
}));

describe("CustomPropertiesSection", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    projectApiMocks.listPropertyDefinitions.mockResolvedValue([
      {
        id: "property-1",
        orgId: "org-1",
        name: "Release train",
        propertyType: "text",
        config: { options: [] },
        position: 0,
        createdAt: "2026-08-20T00:00:00.000Z",
        updatedAt: "2026-08-20T00:00:00.000Z",
      },
    ]);
    projectApiMocks.listWorkItemPropertyValues.mockResolvedValue([]);
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

  it("uses the shared thread card and todo row spacing", async () => {
    await act(async () => {
      root.render(
        createElement(CustomPropertiesSection, {
          orgId: "org-1",
          shortId: "WI-0001",
          editable: true,
        })
      );
    });

    const section = container.querySelector<HTMLElement>(
      "[data-testid='work-item-custom-properties']"
    );
    const row = container
      .querySelector("[data-testid='work-item-property-property-1']")
      ?.closest(".min-h-8");

    expect(section?.className).toContain("rounded-xl");
    expect(section?.className).toContain("border-border-1");
    expect(section?.className).toContain("bg-chat-pane");
    expect(section?.innerHTML).toContain("bg-primary-container px-3 py-2");
    expect(section?.innerHTML).toContain("bg-chat-pane px-3 py-2");
    expect(section?.innerHTML).not.toContain("bg-bg-2 p-3");
    expect(row?.className).toContain("rounded-lg px-0 py-1");
    expect(
      container.querySelector(".lucide-list-chevrons-up-down")
    ).not.toBeNull();

    const addButton = container.querySelector<HTMLButtonElement>(
      "[data-testid='work-item-property-add-toggle']"
    );
    expect(addButton?.textContent).toBe("");
    expect(addButton?.getAttribute("aria-label")).toBe("Add property");
    expect(addButton?.title).toBe("Add property");
    expect(addButton?.querySelector(".lucide-plus")).not.toBeNull();
  });
});
