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

import type { WorkItem } from "@src/types/core/workItem";

import { AssigneePropertyField } from "./AssigneePropertyField";

const workItem = {
  session_id: "issue-42",
  workItemStatus: "open",
  assignee: {
    id: "reviewer",
    name: "reviewer",
    avatar: "https://example.com/reviewer.png",
  },
} as unknown as WorkItem;

const translate = (key: string) => key;

describe("AssigneePropertyField external assignees", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
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
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("loads options on open and preserves selected assignees when adding", async () => {
    const onOpen = vi.fn();
    const onChangeAssigneeIds = vi.fn().mockResolvedValue(undefined);
    act(() => {
      root.render(
        createElement(AssigneePropertyField, {
          workItem,
          availableMembers: [],
          onAssigneeChange: vi.fn(),
          t: translate,
          placement: "inline",
          externalConfig: {
            currentAssigneeIds: ["reviewer"],
            options: [
              {
                id: "reviewer",
                label: "reviewer",
                avatar: "https://example.com/reviewer.png",
              },
              {
                id: "teammate",
                label: "teammate",
                avatar: "https://example.com/teammate.png",
              },
            ],
            onOpen,
            onChangeAssigneeIds,
          },
        })
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="work-item-property-assignee-issue-42"] button'
    );
    expect(trigger).not.toBeNull();
    act(() => trigger?.click());

    expect(onOpen).toHaveBeenCalledTimes(1);
    const teammate = container.querySelector<HTMLButtonElement>(
      '[data-testid="work-item-property-assignee-issue-42-option-teammate"]'
    );
    expect(teammate).not.toBeNull();
    await act(async () => teammate?.click());

    expect(onChangeAssigneeIds).toHaveBeenCalledWith(["reviewer", "teammate"]);
  });

  it("keeps the native trigger disabled without assignment permission", () => {
    const onOpen = vi.fn();
    act(() => {
      root.render(
        createElement(AssigneePropertyField, {
          workItem,
          availableMembers: [],
          onAssigneeChange: vi.fn(),
          t: translate,
          externalConfig: {
            currentAssigneeIds: ["reviewer"],
            options: [],
            disabled: true,
            readonlyReason: "Forbidden",
            onOpen,
            onChangeAssigneeIds: vi.fn(),
          },
        })
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="work-item-property-assignee-issue-42"] button'
    );
    expect(trigger?.disabled).toBe(true);
    expect(trigger?.closest("[title]")?.getAttribute("title")).toBe(
      "Forbidden"
    );
    act(() => trigger?.click());
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("offers human roster members but never agent or organization identities", () => {
    const onAssigneeChange = vi.fn();
    const props = {
      workItem: { ...workItem, assignee: undefined },
      availableMembers: [{ id: "member-1", name: "Ada Lovelace" }],
      onAssigneeChange,
      t: translate,
      placement: "inline" as const,
      active: true,
      // Legacy callers may still have these values in memory during a hot
      // reload. The canonical picker must not turn them into assignment
      // options even when extra runtime props are present.
      allAgentList: [{ id: "builtin:os", name: "OS Agent" }],
      availableOrgs: [{ id: "org-1", name: "Agent Organization" }],
    };

    act(() => {
      root.render(createElement(AssigneePropertyField, props));
    });
    expect(document.body.textContent).toContain("Ada Lovelace");
    expect(document.body.textContent).not.toContain("OS Agent");
    expect(document.body.textContent).not.toContain("Agent Organization");

    const memberOption = Array.from(
      document.querySelectorAll<HTMLButtonElement>("button")
    ).find((button) => button.textContent?.includes("Ada Lovelace"));
    act(() => memberOption?.click());
    expect(onAssigneeChange).toHaveBeenCalledWith({
      id: "member-1",
      name: "Ada Lovelace",
    });
  });
});
