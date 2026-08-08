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

import { chatPanelTabsAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import { settingsAtom } from "@src/store/settings/settingsAtom";

import type { TeamInboxItem } from "../domain";
import { teamInboxCacheAtom, teamInboxItemFocusRequestAtom } from "../store";
import { useTeamInboxNotifications } from "../useTeamInboxNotifications";

const mocks = vi.hoisted(() => ({
  notifyTeamInbox: vi.fn(),
  setDockBadge: vi.fn(),
  listenForSystemNotificationActions: vi.fn(),
  registerTeamInboxNotificationActionType: vi.fn(),
  messageInfo: vi.fn(),
  windowShow: vi.fn(),
  windowSetFocus: vi.fn(),
}));

vi.mock("@src/api/services/notification", () => ({
  listenForSystemNotificationActions: mocks.listenForSystemNotificationActions,
  notifyTeamInbox: mocks.notifyTeamInbox,
  registerTeamInboxNotificationActionType:
    mocks.registerTeamInboxNotificationActionType,
  setDockBadge: mocks.setDockBadge,
}));

vi.mock("@src/hooks/logger", () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn() }),
}));

vi.mock("@src/components/Message", () => ({
  default: { info: mocks.messageInfo },
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    show: mocks.windowShow,
    setFocus: mocks.windowSetFocus,
  }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { name?: string; count?: number }) =>
      options?.name
        ? `${key}:${options.name}`
        : options?.count
          ? `${key}:${options.count}`
          : key,
  }),
}));

function assignment(id: string, occurredAt: string): TeamInboxItem {
  return {
    id,
    kind: "assigned_work_item",
    occurredAt,
    readAt: null,
    actor: { id: "sender", displayName: "Ada" },
    target: { kind: "work_item", projectId: "", workItemId: id },
    payload: {
      title: `Work ${id}`,
      status: "open",
      priority: "medium",
      assigneeMemberId: "viewer",
      updatedAt: occurredAt,
    },
  };
}

function Harness(): null {
  useTeamInboxNotifications();
  return null;
}

describe("useTeamInboxNotifications", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    mocks.notifyTeamInbox.mockReset().mockResolvedValue({
      systemSent: true,
      soundPlayed: true,
    });
    mocks.setDockBadge.mockReset().mockResolvedValue(true);
    mocks.listenForSystemNotificationActions
      .mockReset()
      .mockResolvedValue(vi.fn());
    mocks.registerTeamInboxNotificationActionType
      .mockReset()
      .mockResolvedValue(undefined);
    mocks.messageInfo.mockReset();
    mocks.windowShow.mockReset().mockResolvedValue(undefined);
    mocks.windowSetFocus.mockReset().mockResolvedValue(undefined);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  it("baselines history, notifies one new assignment, and mirrors unread badge count", async () => {
    const store = createStore();
    store.set(settingsAtom, {
      ...store.get(settingsAtom),
      "notifications.enabled": true,
      "notifications.systemNotificationEnabled": true,
      "notifications.dockBadgeEnabled": true,
      "notifications.completionSound": false,
      "notifications.categories.teamInbox": true,
    });
    store.set(teamInboxCacheAtom, {
      items: [assignment("old", "2026-07-29T08:00:00.000Z")],
      unreadCount: 1,
      unreadCounts: { all: 1, assigned: 1, mentions: 0 },
      loading: false,
      issue: null,
      revision: 1,
      loadedForViewerKey: "viewer::org-a",
      hasMore: false,
    });

    await act(async () => {
      root.render(createElement(Provider, { store }, createElement(Harness)));
    });
    expect(mocks.notifyTeamInbox).not.toHaveBeenCalled();
    expect(mocks.setDockBadge).toHaveBeenLastCalledWith(1);

    await act(async () => {
      store.set(teamInboxCacheAtom, (current) => ({
        ...current,
        items: [assignment("new", new Date().toISOString()), ...current.items],
        unreadCount: 2,
        unreadCounts: { all: 2, assigned: 2, mentions: 0 },
        revision: current.revision + 1,
      }));
    });

    expect(mocks.notifyTeamInbox).toHaveBeenCalledTimes(1);
    expect(mocks.notifyTeamInbox).toHaveBeenCalledWith(
      "Ada · teamInbox.notifications.assignmentTitle",
      "Work new",
      expect.objectContaining({
        categories: expect.objectContaining({ teamInbox: true }),
      }),
      {
        orgiiTarget: "team-inbox",
        teamInboxItemKey: "assigned_work_item:new",
      }
    );
    expect(mocks.messageInfo).toHaveBeenCalledOnce();
    const toast = mocks.messageInfo.mock.calls[0]?.[0] as
      | {
          title?: string;
          action?: { label: string; onClick: () => void };
        }
      | undefined;
    expect(toast).toMatchObject({
      title: "Ada · teamInbox.notifications.assignmentTitle",
      action: { label: "common:actions.view" },
    });

    act(() => toast?.action?.onClick());
    expect(store.get(teamInboxItemFocusRequestAtom)?.itemKey).toBe(
      "assigned_work_item:new"
    );
    expect(
      store.get(chatPanelTabsAtom).tabs.find((tab) => tab.type === "team-inbox")
        ?.title
    ).toBe("navigation:labels.inbox");
    expect(mocks.setDockBadge).toHaveBeenLastCalledWith(2);
  });

  it("opens and focuses the matching Inbox item from a native notification action", async () => {
    const store = createStore();
    store.set(settingsAtom, {
      ...store.get(settingsAtom),
      "notifications.enabled": true,
      "notifications.categories.teamInbox": true,
    });
    store.set(teamInboxCacheAtom, {
      items: [assignment("old", new Date().toISOString())],
      unreadCount: 1,
      unreadCounts: { all: 1, assigned: 1, mentions: 0 },
      loading: false,
      issue: null,
      revision: 1,
      loadedForViewerKey: "viewer::org-a",
      hasMore: false,
    });

    await act(async () => {
      root.render(createElement(Provider, { store }, createElement(Harness)));
    });

    const nativeHandler = mocks.listenForSystemNotificationActions.mock
      .calls[0]?.[0] as
      | ((action: { extra: Record<string, unknown> }) => void)
      | undefined;
    await act(async () => {
      nativeHandler?.({
        extra: {
          orgiiTarget: "team-inbox",
          teamInboxItemKey: "assigned_work_item:old",
        },
      });
      await Promise.resolve();
    });

    expect(store.get(teamInboxItemFocusRequestAtom)?.itemKey).toBe(
      "assigned_work_item:old"
    );
    expect(
      store.get(chatPanelTabsAtom).tabs.find((tab) => tab.type === "team-inbox")
        ?.title
    ).toBe("navigation:labels.inbox");
    expect(mocks.windowShow).toHaveBeenCalledOnce();
    expect(mocks.windowSetFocus).toHaveBeenCalledOnce();
  });

  it("releases the single native action listener when the global host unmounts", async () => {
    const dispose = vi.fn();
    mocks.listenForSystemNotificationActions.mockResolvedValueOnce(dispose);
    const store = createStore();

    await act(async () => {
      root.render(createElement(Provider, { store }, createElement(Harness)));
      await Promise.resolve();
    });

    act(() => root.unmount());
    expect(dispose).toHaveBeenCalledOnce();

    root = createRoot(container);
  });

  it("clears the badge and suppresses delivery when Team Inbox notifications are disabled", async () => {
    const store = createStore();
    store.set(settingsAtom, {
      ...store.get(settingsAtom),
      "notifications.enabled": true,
      "notifications.dockBadgeEnabled": true,
      "notifications.categories.teamInbox": false,
    });
    store.set(teamInboxCacheAtom, {
      items: [assignment("old", new Date().toISOString())],
      unreadCount: 1,
      unreadCounts: { all: 1, assigned: 1, mentions: 0 },
      loading: false,
      issue: null,
      revision: 1,
      loadedForViewerKey: "viewer::org-a",
      hasMore: false,
    });

    await act(async () => {
      root.render(createElement(Provider, { store }, createElement(Harness)));
    });

    expect(mocks.setDockBadge).toHaveBeenLastCalledWith(0);
    expect(mocks.notifyTeamInbox).not.toHaveBeenCalled();
    expect(mocks.messageInfo).not.toHaveBeenCalled();
  });
});
