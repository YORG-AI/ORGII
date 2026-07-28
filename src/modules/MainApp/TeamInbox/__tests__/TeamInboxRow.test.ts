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

import TeamInboxRow from "../components/TeamInboxRow";
import type { AssignedWorkItem } from "../domain";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? _key,
  }),
}));

const assignedItem: AssignedWorkItem = {
  id: "assigned-1",
  kind: "assigned_work_item",
  occurredAt: new Date().toISOString(),
  readAt: "2026-07-28T00:00:00.000Z",
  actor: { id: "member-1", displayName: "Yuki" },
  target: { kind: "work_item", projectId: "demo", workItemId: "AAA-0001" },
  payload: {
    title: "验收 Team Inbox 的真实分配与已读流程",
    status: "todo",
    priority: "medium",
    assigneeMemberId: "member-1",
    assigneeName: "Yuki",
    summary:
      "## 验收目标\\n- 在 Team Inbox 的“全部”和“分配给我”中看到此事项\\n- 打开详情并标记已读",
    updatedAt: "2026-07-28T00:00:00.000Z",
  },
};

describe("TeamInboxRow", () => {
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

  it("renders a compact plain-text excerpt and useful Work Item metadata", () => {
    act(() => {
      root.render(
        createElement(TeamInboxRow, {
          item: assignedItem,
          itemKey: "assigned_work_item:assigned-1",
          selected: true,
          onSelect: vi.fn(),
        })
      );
    });

    const summary = container.querySelector("[title]");
    expect(summary?.textContent).toBe(
      "验收目标 在 Team Inbox 的“全部”和“分配给我”中看到此事项 打开详情并标记已读"
    );
    expect(summary?.textContent).not.toContain("\\n");
    expect(summary?.textContent).not.toContain("##");
    expect(summary?.className).toContain("max-h-10");
    expect(summary?.className).toContain("text-text-1");
    expect(container.textContent).toContain("Todo · Medium");
    expect(container.textContent).not.toContain("Yuki");
  });

  it("omits the excerpt row when an assigned item has no summary", () => {
    act(() => {
      root.render(
        createElement(TeamInboxRow, {
          item: {
            ...assignedItem,
            payload: { ...assignedItem.payload, summary: undefined },
          },
          itemKey: "assigned_work_item:assigned-1",
          selected: false,
          onSelect: vi.fn(),
        })
      );
    });

    expect(container.querySelector("[title]")).toBeNull();
    expect(container.textContent).toContain("Todo · Medium");
  });
});
