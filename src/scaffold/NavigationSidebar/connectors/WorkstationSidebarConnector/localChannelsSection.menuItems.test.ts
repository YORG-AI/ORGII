import type { TFunction } from "i18next";
import { describe, expect, it, vi } from "vitest";

import { HashtagIcon } from "@src/icons";
import type { LocalChannel } from "@src/store/ui/localChannelsAtom";

import {
  type BuildLocalChannelsMenuItemsParams,
  LOCAL_CHANNELS_ARCHIVED_GROUP_ID,
  LOCAL_CHANNELS_EMPTY_ID,
  buildLocalChannelRowId,
  buildLocalChannelsMenuItems,
  isLocalChannelsMenuItemId,
} from "./localChannelsSection.menuItems";

// Key-echoing translator: assertions read as raw i18n keys.
const t = ((key: string) => key) as unknown as TFunction;

function makeChannel(overrides: Partial<LocalChannel> = {}): LocalChannel {
  return {
    id: "ch-1",
    name: "general",
    topic: undefined,
    createdAt: "2026-07-31T00:00:00Z",
    updatedAt: "2026-07-31T00:00:00Z",
    archivedAt: null,
    ...overrides,
  };
}

function buildParams(
  overrides: Partial<BuildLocalChannelsMenuItemsParams> = {}
): BuildLocalChannelsMenuItemsParams {
  return {
    enabled: true,
    channels: [],
    archivedChannels: [],
    t,
    tCommon: t,
    onCreateClick: vi.fn(),
    onOpenChannelMenu: vi.fn(),
    onUnarchive: vi.fn(),
    onDeleteChannel: vi.fn(),
    ...overrides,
  };
}

describe("local channels section visibility", () => {
  it("emits nothing while a cloud org scope is active", () => {
    expect(
      buildLocalChannelsMenuItems(
        buildParams({ enabled: false, channels: [makeChannel()] })
      )
    ).toEqual([]);
  });

  it("renders the separator header with the create action", () => {
    const onCreateClick = vi.fn();
    const items = buildLocalChannelsMenuItems(buildParams({ onCreateClick }));
    expect(items[0]?.id).toBe("separator-local-channels");
    expect(items[0]?.label).toBe("cloud.channels.title");
    const createAction = items[0]?.rowActions?.[0];
    expect(createAction?.dataTestId).toBe("local-channels-create");
    expect(createAction?.label).toBe("cloud.channels.createAction");
    createAction?.onClick({} as never);
    expect(onCreateClick).toHaveBeenCalledOnce();
  });
});

describe("local channel rows", () => {
  it("always uses # rows (no private visibility locally) with topic search", () => {
    const channel = makeChannel({ id: "ch-a", name: "plans", topic: "Q3" });
    const items = buildLocalChannelsMenuItems(
      buildParams({ channels: [channel] })
    );
    const row = items[1];
    expect(row.id).toBe(buildLocalChannelRowId("ch-a"));
    expect(row.icon).toBe(HashtagIcon);
    expect(row.label).toBe("plans");
    expect(row.searchText).toBe("plans Q3");
    expect(row.dataTestId).toBe("sidebar-local-channel-ch-a");
  });

  it("opens the overflow menu from the row's more action", () => {
    const channel = makeChannel({ id: "ch-a" });
    const onOpenChannelMenu = vi.fn();
    const items = buildLocalChannelsMenuItems(
      buildParams({ channels: [channel], onOpenChannelMenu })
    );
    const row = items[1];
    expect(row.showMoreActions).toBe(true);
    const moreAction = row.rowActions?.[0];
    expect(moreAction?.dataTestId).toBe("local-channel-more-ch-a");
    moreAction?.onClick({} as never);
    expect(onOpenChannelMenu).toHaveBeenCalledWith(channel);
  });

  it("shows a clickable muted create row when there are zero channels", () => {
    const items = buildLocalChannelsMenuItems(buildParams());
    const emptyRow = items[1];
    expect(emptyRow.id).toBe(LOCAL_CHANNELS_EMPTY_ID);
    expect(emptyRow.label).toBe("cloud.channels.createFirst");
    expect(emptyRow.visualTone).toBe("secondary");
    expect(emptyRow.disabled).toBeUndefined();
  });
});

describe("archived subgroup", () => {
  const archived = makeChannel({
    id: "ch-arch",
    name: "old-plans",
    archivedAt: "2026-07-31T01:00:00Z",
  });

  it("is absent while no archived channels exist", () => {
    const items = buildLocalChannelsMenuItems(
      buildParams({ channels: [makeChannel()] })
    );
    expect(
      items.some((item) => item.id === LOCAL_CHANNELS_ARCHIVED_GROUP_ID)
    ).toBe(false);
  });

  it("renders a trailing group whose rows carry unarchive/delete actions", () => {
    const onUnarchive = vi.fn();
    const onDeleteChannel = vi.fn();
    const items = buildLocalChannelsMenuItems(
      buildParams({
        channels: [makeChannel()],
        archivedChannels: [archived],
        onUnarchive,
        onDeleteChannel,
      })
    );
    const group = items[items.length - 1];
    expect(group.id).toBe(LOCAL_CHANNELS_ARCHIVED_GROUP_ID);
    expect(group.label).toBe("cloud.channels.archivedGroup");
    // Group header (no navigableParent): the NavigationMenu primitive keeps
    // it collapsed until the user toggles it.
    expect(group.navigableParent).toBeUndefined();
    expect(group.children).toHaveLength(1);
    const row = group.children?.[0];
    expect(row?.dataTestId).toBe("sidebar-local-channel-ch-arch");
    const [unarchiveAction, deleteAction] = row?.rowActions ?? [];
    expect(unarchiveAction?.dataTestId).toBe("local-channel-unarchive-ch-arch");
    expect(deleteAction?.dataTestId).toBe("local-channel-delete-ch-arch");
    unarchiveAction?.onClick({} as never);
    deleteAction?.onClick({} as never);
    expect(onUnarchive).toHaveBeenCalledWith(archived);
    expect(onDeleteChannel).toHaveBeenCalledWith(archived);
  });
});

describe("menu item id ownership", () => {
  it("claims exactly the section's own ids", () => {
    expect(isLocalChannelsMenuItemId("separator-local-channels")).toBe(true);
    expect(isLocalChannelsMenuItemId(LOCAL_CHANNELS_EMPTY_ID)).toBe(true);
    expect(isLocalChannelsMenuItemId(LOCAL_CHANNELS_ARCHIVED_GROUP_ID)).toBe(
      true
    );
    expect(isLocalChannelsMenuItemId(buildLocalChannelRowId("ch-1"))).toBe(
      true
    );
    // Cloud ids and session ids must never be claimed.
    expect(isLocalChannelsMenuItemId("separator-cloud-channels")).toBe(false);
    expect(isLocalChannelsMenuItemId("cloud-channels-empty")).toBe(false);
    expect(isLocalChannelsMenuItemId("cloudremote-org-1|row-1")).toBe(false);
    expect(isLocalChannelsMenuItemId("load-more-today")).toBe(false);
  });
});
