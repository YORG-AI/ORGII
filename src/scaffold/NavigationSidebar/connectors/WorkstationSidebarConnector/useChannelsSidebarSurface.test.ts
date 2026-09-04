// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";

import { useChannelsSidebarSurface } from "./useChannelsSidebarSurface";

const mocks = vi.hoisted(() => ({
  cloud: vi.fn(),
  local: vi.fn(),
  cloudClick: vi.fn(),
  localClick: vi.fn(),
  cloudMounted: vi.fn(),
  cloudUnmounted: vi.fn(),
  localMounted: vi.fn(),
  localUnmounted: vi.fn(),
}));
vi.mock("./channelsSection", () => ({
  useCloudChannelsSection: (params: { orgId: string | null }) => {
    useEffect(() => {
      mocks.cloudMounted();
      return () => mocks.cloudUnmounted();
    }, []);
    return mocks.cloud(params);
  },
}));
vi.mock("./localChannelsSection", () => ({
  useLocalChannelsSection: (params: { enabled: boolean }) => {
    useEffect(() => {
      mocks.localMounted();
      return () => mocks.localUnmounted();
    }, []);
    return mocks.local(params);
  },
}));
const localRows = [
  { id: "local-channel-a", key: "local-channel-a", label: "Local A" },
];
const cloudRows = [
  { id: "cloud-channel-a", key: "cloud-channel-a", label: "Team A" },
];

describe("channel sidebar surface ownership", () => {
  let root: Root;
  let surface: ReturnType<typeof useChannelsSidebarSurface>;
  function Probe({ orgId }: { orgId: string | null }) {
    const value = useChannelsSidebarSurface(orgId);
    useEffect(() => {
      surface = value;
    });
    return null;
  }
  const render = (orgId: string | null) =>
    act(() => root.render(createElement(Probe, { orgId })));
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    vi.clearAllMocks();
    mocks.cloudClick.mockReturnValue(false);
    mocks.localClick.mockReturnValue(false);
    mocks.cloud.mockReturnValue({
      channelsMenuItems: cloudRows,
      selectedChannelMenuItemId: "cloud-selected",
      handleChannelsItemClick: mocks.cloudClick,
      channelsDialogs: "cloud-dialog",
    });
    mocks.local.mockReturnValue({
      localChannelsMenuItems: localRows,
      selectedLocalChannelMenuItemId: null,
      handleLocalChannelsItemClick: mocks.localClick,
      localChannelsDialogs: "local-dialog",
    });
    root = createRoot(document.createElement("div"));
  });
  afterEach(() => {
    act(() => root.unmount());
    Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("keeps both controllers mounted while retaining the exact cloud/local scope gates and dialogs", () => {
    render("org-a");
    expect(mocks.cloud).toHaveBeenLastCalledWith({ orgId: "org-a" });
    expect(mocks.local).toHaveBeenLastCalledWith({ enabled: false });
    expect(surface.menuItems).toBe(cloudRows);
    expect(surface.cloudMenuItems).toBe(cloudRows);
    expect(surface.selectedMenuItemId).toBe("cloud-selected");
    expect([surface.cloudDialogs, surface.localDialogs]).toEqual([
      "cloud-dialog",
      "local-dialog",
    ]);
    render(null);
    expect(mocks.local).toHaveBeenLastCalledWith({ enabled: true });
    render("org-b");
    expect(mocks.cloud).toHaveBeenLastCalledWith({ orgId: "org-b" });
    expect(mocks.cloudMounted).toHaveBeenCalledOnce();
    expect(mocks.localMounted).toHaveBeenCalledOnce();
    expect(mocks.cloudUnmounted).not.toHaveBeenCalled();
    expect(mocks.localUnmounted).not.toHaveBeenCalled();
  });

  it("uses the existing empty-cloud row fallback and local selection precedence independently", () => {
    mocks.cloud.mockReturnValue({
      channelsMenuItems: [],
      selectedChannelMenuItemId: "cloud-selected",
      handleChannelsItemClick: mocks.cloudClick,
      channelsDialogs: null,
    });
    mocks.local.mockReturnValue({
      localChannelsMenuItems: localRows,
      selectedLocalChannelMenuItemId: "local-selected",
      handleLocalChannelsItemClick: mocks.localClick,
      localChannelsDialogs: null,
    });
    render(null);
    expect(surface.menuItems).toBe(localRows);
    expect(surface.cloudMenuItems).toEqual([]);
    expect(surface.selectedMenuItemId).toBe("local-selected");
  });

  it("lets the local controller claim first, then the cloud controller, and leaves other rows unclaimed", () => {
    render("org-a");
    const item: NavigationMenuItem = localRows[0];
    mocks.localClick.mockReturnValue(true);
    expect(surface.handleItemClick(item)).toBe(true);
    expect(mocks.localClick).toHaveBeenLastCalledWith(item, "default");
    expect(mocks.cloudClick).not.toHaveBeenCalled();
    mocks.localClick.mockReturnValue(false);
    mocks.cloudClick.mockReturnValue(true);
    expect(surface.handleItemClick(cloudRows[0])).toBe(true);
    expect(mocks.cloudClick).toHaveBeenLastCalledWith(cloudRows[0], "default");
    mocks.cloudClick.mockReturnValue(false);
    expect(
      surface.handleItemClick({
        id: "session",
        key: "session",
        label: "Session",
      })
    ).toBe(false);
  });
});
