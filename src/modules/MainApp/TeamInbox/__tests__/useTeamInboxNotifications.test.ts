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

import { settingsAtom } from "@src/store/settings/settingsAtom";

import type { TeamInboxItem } from "../domain";
import { teamInboxCacheAtom } from "../store";
import { useTeamInboxNotifications } from "../useTeamInboxNotifications";

const mocks = vi.hoisted(() => ({
  notifyTeamInbox: vi.fn(),
  setDockBadge: vi.fn(),
}));

vi.mock("@src/api/services/notification", () => ({
  notifyTeamInbox: mocks.notifyTeamInbox,
  setDockBadge: mocks.setDockBadge,
}));

vi.mock("@src/hooks/logger", () => ({
  createLogger: () => ({ error: vi.fn() }),
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
      "teamInbox.notifications.assignmentTitle",
      "Work new",
      expect.objectContaining({
        categories: expect.objectContaining({ teamInbox: true }),
      })
    );
    expect(mocks.setDockBadge).toHaveBeenLastCalledWith(2);
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
  });
});
