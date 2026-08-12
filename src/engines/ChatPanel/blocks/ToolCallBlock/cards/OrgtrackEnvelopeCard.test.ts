// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { stationChatVisibilityAtom } from "@src/store/ui/chatPanelAtom";
import { stationModeAtom } from "@src/store/ui/simulatorAtom";
import { workstationLayoutAtom } from "@src/store/workstation";

import type { OrgtrackEnvelopeData } from "../types";
import OrgtrackEnvelopeCard from "./OrgtrackEnvelopeCard";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const NOW = "2026-08-09T00:00:00.000Z";
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

function workItemCard(
  operationId: "work.create" | "work.update" = "work.create"
): OrgtrackEnvelopeData {
  return {
    command: `org2-pm work ${operationId === "work.create" ? "create" : "update WI-0101"} --standalone --title Card`,
    ok: true,
    operationId,
    operation:
      operationId === "work.create" ? "Created work item" : "Updated work item",
    exitCode: 0,
    shortId: "WI-0101",
    title: "Card",
    status: "backlog",
    isStandalone: true,
    orgId: "cloud:cloud:org-1",
    workItem: {
      body: "Open this item",
      filename: "WI-0101",
      frontmatter: {
        id: "WI-0101",
        short_id: "WI-0101",
        title: "Card",
        status: "backlog",
        priority: "none",
        labels: [],
        todos: [],
        starred: false,
        created_at: NOW,
        updated_at: NOW,
      },
    },
  };
}

describe("OrgtrackEnvelopeCard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("switches to My Station and opens the created item detail there", () => {
    const store = createStore();
    store.set(stationModeAtom, "agent-station");
    store.set(workstationLayoutAtom, {
      mainPane: { tabs: [], activeTabId: null },
    });
    store.set(stationChatVisibilityAtom, {
      "my-station": false,
      "agent-station": true,
    });

    act(() => {
      root = createRoot(container);
      root.render(
        createElement(
          Provider,
          { store },
          createElement(OrgtrackEnvelopeCard, { card: workItemCard() })
        )
      );
    });
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="work-item-result-card"]'
    );
    expect(button).not.toBeNull();

    act(() => button?.click());

    expect(store.get(stationModeAtom)).toBe("my-station");
    expect(store.get(stationChatVisibilityAtom)["my-station"]).toBe(true);
    const panel = store.get(workstationLayoutAtom).mainPane;
    const activeTab = panel.tabs.find((tab) => tab.id === panel.activeTabId);
    expect(activeTab).toMatchObject({
      type: "workItem-detail",
      title: "Card",
      data: {
        workItemId: "WI-0101",
        workItemName: "Card",
        workItemStatus: "backlog",
        orgId: "org-1",
      },
    });
  });

  it("opens a host-bootstrapped item from its first work.update result", () => {
    const store = createStore();
    store.set(stationModeAtom, "agent-station");
    store.set(workstationLayoutAtom, {
      mainPane: { tabs: [], activeTabId: null },
    });

    act(() => {
      root = createRoot(container);
      root.render(
        createElement(
          Provider,
          { store },
          createElement(OrgtrackEnvelopeCard, {
            card: workItemCard("work.update"),
          })
        )
      );
    });

    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="work-item-result-card"]'
    );
    expect(button).not.toBeNull();

    act(() => button?.click());

    expect(store.get(stationModeAtom)).toBe("my-station");
    const panel = store.get(workstationLayoutAtom).mainPane;
    expect(
      panel.tabs.find((tab) => tab.id === panel.activeTabId)
    ).toMatchObject({
      type: "workItem-detail",
      data: { workItemId: "WI-0101" },
    });
  });
});
