// @vitest-environment jsdom
import type { TFunction } from "i18next";
import { type MouseEvent, act, createElement, useEffect } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";
import type { Session } from "@src/store/session";

import {
  NEW_SESSION_MENU_ITEM_ID,
  TEAM_INBOX_MENU_ITEM_ID,
  getDraftMenuItemId,
} from "../sidebarConnectorUtils";
import { useWorkstationSidebarMenuItemRouting } from "./sidebarConnector.menuItemRouting";

vi.mock("./menuItemWrappers", () => ({
  useRenderSessionMenuItemWrapper: () => vi.fn(),
  useRenderWorkstationMenuItemWrapper: () => vi.fn(),
}));
const translate = (key: string) => key;
const row = (id: string): NavigationMenuItem => ({ id, key: id, label: id });
const mouseEvent = (metaKey = false, ctrlKey = false) =>
  ({ metaKey, ctrlKey }) as MouseEvent;

describe("sidebar cross-surface routing precedence", () => {
  let root: Root;
  let routing: ReturnType<typeof useWorkstationSidebarMenuItemRouting>;
  const sessionClick = vi.fn();
  const projectsClick = vi.fn();
  const openInNewTab = vi.fn();
  const openTeamInbox = vi.fn();
  const closeOtherTabs = vi.fn(async () => undefined);
  const session: Session = {
    session_id: "session-a",
    status: "completed",
    created_at: "2026-08-31T00:00:00Z",
    updated_at: "2026-08-31T00:00:00Z",
  };
  const sessionMap = new Map([[session.session_id, session]]);

  function Probe({
    workItemsContentVisible,
  }: {
    workItemsContentVisible: boolean;
  }) {
    const value = useWorkstationSidebarMenuItemRouting({
      sessionMap,
      cloudRemoteRowMap: new Map(),
      cloudRemoteViewerMap: new Map(),
      tSessions: translate as TFunction<"sessions">,
      t: translate as TFunction<"navigation">,
      setWorkManagementProjectsView: vi.fn(),
      openWorkManagementTab: vi.fn(),
      openRuntimeTab: vi.fn(),
      runtimeLabel: "Runtime",
      openTeamInboxTab: openTeamInbox,
      activateChatPanelTab: vi.fn(),
      handleMenuItemClick: sessionClick,
      workItemsContentVisible,
      handleProjectsMenuItemClick: projectsClick,
      handleOpenInNewTab: openInNewTab,
      closeOtherThanActiveChatPanelTabs: closeOtherTabs,
    });
    useEffect(() => {
      routing = value;
    });
    return null;
  }
  const render = (workItemsContentVisible: boolean) =>
    act(() => root.render(createElement(Probe, { workItemsContentVisible })));
  const click = (item: NavigationMenuItem, event = mouseEvent()) =>
    routing.handleSessionMenuItemClick(item.key, item, event);

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.clearAllMocks();
    root = createRoot(document.createElement("div"));
  });
  afterEach(() => {
    act(() => root.unmount());
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("routes drafts and New conversation to session actions before work-item routing", () => {
    render(true);
    const newConversation = row(NEW_SESSION_MENU_ITEM_ID);
    const draft = row(getDraftMenuItemId("draft-a"));
    click(newConversation);
    click(draft);
    expect(sessionClick.mock.calls).toEqual([
      [newConversation.key, newConversation, "replace-all"],
      [draft.key, draft, "replace-all"],
    ]);
    expect(closeOtherTabs).toHaveBeenCalledTimes(2);
    expect(projectsClick).not.toHaveBeenCalled();
    const workItem = row("projects-work-item:work-a");
    click(workItem, mouseEvent(true));
    expect(projectsClick).toHaveBeenCalledWith(workItem.key, workItem);
    expect(openInNewTab).not.toHaveBeenCalled();
  });

  it("retains modifier-click session opening only in the session surface", () => {
    render(false);
    click(row(session.session_id), mouseEvent(true));
    click(row(session.session_id), mouseEvent(false, true));
    expect(openInNewTab).toHaveBeenCalledTimes(2);
    const remote = row("cloudremote-session-a");
    click(remote, mouseEvent(true));
    expect(sessionClick).toHaveBeenCalledWith(remote.key, remote, "new-tab");
    render(true);
    const item = row(session.session_id);
    click(item, mouseEvent(true));
    expect(projectsClick).toHaveBeenCalledWith(item.key, item);
    expect(openInNewTab).toHaveBeenCalledTimes(2);
  });

  it("replaces the tab strip on plain sidebar navigation and preserves it for modifiers", () => {
    render(false);
    const inbox = row(TEAM_INBOX_MENU_ITEM_ID);
    click(inbox);
    click(inbox, mouseEvent(true));
    expect(openTeamInbox).toHaveBeenCalledTimes(2);
    expect(closeOtherTabs).toHaveBeenCalledOnce();

    const sessionItem = row(session.session_id);
    click(sessionItem);
    click(sessionItem, mouseEvent(false, true));
    expect(closeOtherTabs).toHaveBeenCalledTimes(2);
    expect(openInNewTab).toHaveBeenCalledWith(session.session_id);
  });

  it("uses the same new-tab route for a context-menu action", () => {
    render(false);
    const inbox = row(TEAM_INBOX_MENU_ITEM_ID);
    routing.handleSessionMenuItemOpenInNewTab(inbox.key, inbox);
    expect(openTeamInbox).toHaveBeenCalledWith(inbox.label);
    expect(closeOtherTabs).not.toHaveBeenCalled();
  });

  it("preserves Team Inbox routing in the legacy projects scope", () => {
    render(true);
    const item = row(TEAM_INBOX_MENU_ITEM_ID);
    routing.handleProjectsScopeMenuItemClick(item.key, item, mouseEvent());
    expect(openTeamInbox).toHaveBeenCalledWith(item.label);
    expect(projectsClick).not.toHaveBeenCalled();
    expect(closeOtherTabs).toHaveBeenCalledOnce();
  });
});
