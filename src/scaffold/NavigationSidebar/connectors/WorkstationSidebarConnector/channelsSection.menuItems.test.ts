import type { TFunction } from "i18next";
import { describe, expect, it, vi } from "vitest";

import type { CloudChannel } from "@src/features/Org2Cloud/channels/types";
import { HashtagIcon, LockIcon } from "@src/icons";

import {
  type BuildCloudChannelsMenuItemsParams,
  CLOUD_CHANNELS_ARCHIVED_GROUP_ID,
  CLOUD_CHANNELS_EMPTY_ID,
  buildArchivedChannelActionKinds,
  buildChannelActionKinds,
  buildCloudChannelRowId,
  buildCloudChannelsMenuItems,
  isCloudChannelsMenuItemId,
  isCloudOrgAdminRole,
  shouldRenderChannelsSection,
} from "./channelsSection.menuItems";

// Key-echoing translator: assertions read as raw i18n keys.
const t = ((key: string) => key) as unknown as TFunction;

function makeChannel(overrides: Partial<CloudChannel> = {}): CloudChannel {
  return {
    id: "ch-1",
    name: "general",
    topic: undefined,
    visibility: "org",
    postPolicy: "everyone",
    createdBy: undefined,
    createdAt: "2026-07-30T00:00:00Z",
    updatedAt: undefined,
    archivedAt: null,
    messageCount: 0,
    lastMessageAt: undefined,
    memberCount: 3,
    myRole: "member",
    ...overrides,
  };
}

function buildParams(
  overrides: Partial<BuildCloudChannelsMenuItemsParams> = {}
): BuildCloudChannelsMenuItemsParams {
  return {
    orgId: "org-1",
    phase: "ready",
    channels: [],
    archivedChannels: [],
    isOrgAdmin: false,
    t,
    tCommon: t,
    onCreateClick: vi.fn(),
    onOpenChannelMenu: vi.fn(),
    onUnarchive: vi.fn(),
    onDeleteChannel: vi.fn(),
    ...overrides,
  };
}

describe("channels section visibility", () => {
  it("hides the section entirely on unsupported and signedOut phases", () => {
    expect(shouldRenderChannelsSection("unsupported")).toBe(false);
    expect(shouldRenderChannelsSection("signedOut")).toBe(false);
    expect(
      buildCloudChannelsMenuItems(buildParams({ phase: "unsupported" }))
    ).toEqual([]);
    expect(
      buildCloudChannelsMenuItems(buildParams({ phase: "signedOut" }))
    ).toEqual([]);
  });

  it("emits nothing without an active cloud org scope", () => {
    expect(buildCloudChannelsMenuItems(buildParams({ orgId: null }))).toEqual(
      []
    );
  });

  it("attaches the create action only once the phase is ready", () => {
    const onCreateClick = vi.fn();
    const items = buildCloudChannelsMenuItems(
      buildParams({ phase: "ready", onCreateClick })
    );
    expect(items[0]?.id).toBe("separator-cloud-channels");
    expect(items[0]?.label).toBe("cloud.channels.title");
    const createAction = items[0]?.rowActions?.[0];
    expect(createAction?.dataTestId).toBe("cloud-channels-create");
    createAction?.onClick({} as never);
    expect(onCreateClick).toHaveBeenCalledOnce();

    // While the capability probe is unresolved (or the list failed) the
    // header renders WITHOUT create: offering it funnels the user into a
    // submit that can only 404 on a pre-0014 backend.
    for (const phase of ["loading", "error"] as const) {
      const gated = buildCloudChannelsMenuItems(buildParams({ phase }));
      expect(gated[0]?.id).toBe("separator-cloud-channels");
      expect(gated[0]?.rowActions).toBeUndefined();
    }
  });
});

describe("channel rows", () => {
  it("uses # for org-visible channels and a lock for private ones", () => {
    const items = buildCloudChannelsMenuItems(
      buildParams({
        channels: [
          makeChannel({ id: "ch-org", name: "general" }),
          makeChannel({
            id: "ch-priv",
            name: "secrets",
            visibility: "private",
          }),
        ],
      })
    );
    const [orgRow, privateRow] = items.slice(1);
    expect(orgRow.id).toBe(buildCloudChannelRowId("org-1", "ch-org"));
    expect(orgRow.icon).toBe(HashtagIcon);
    expect(orgRow.dataTestId).toBe("sidebar-cloud-channel-ch-org");
    expect(privateRow.icon).toBe(LockIcon);
    expect(privateRow.label).toBe("secrets");
  });

  it("opens the overflow menu with the row's gated entries", () => {
    const channel = makeChannel({ id: "ch-org" });
    const onOpenChannelMenu = vi.fn();
    const items = buildCloudChannelsMenuItems(
      buildParams({ channels: [channel], isOrgAdmin: true, onOpenChannelMenu })
    );
    const row = items[1];
    expect(row.showMoreActions).toBe(true);
    const moreAction = row.rowActions?.[0];
    expect(moreAction?.dataTestId).toBe("cloud-channel-more-ch-org");
    moreAction?.onClick({} as never);
    expect(onOpenChannelMenu).toHaveBeenCalledWith(channel, [
      "manageMembers",
      "archive",
      "delete",
    ]);
  });
});

describe("row-action gating", () => {
  it("treats owner and admin org roles as admin", () => {
    expect(isCloudOrgAdminRole("owner")).toBe(true);
    expect(isCloudOrgAdminRole("admin")).toBe(true);
    expect(isCloudOrgAdminRole("member")).toBe(false);
    expect(isCloudOrgAdminRole(undefined)).toBe(false);
  });

  it("plain members only manage members (plus leave on private)", () => {
    expect(buildChannelActionKinds(makeChannel(), false)).toEqual([
      "manageMembers",
    ]);
    expect(
      buildChannelActionKinds(makeChannel({ visibility: "private" }), false)
    ).toEqual(["manageMembers", "leave"]);
  });

  it("channel managers gain archive but not delete", () => {
    expect(
      buildChannelActionKinds(makeChannel({ myRole: "manager" }), false)
    ).toEqual(["manageMembers", "archive"]);
  });

  it("org admins gain archive and delete without channel membership", () => {
    expect(
      buildChannelActionKinds(makeChannel({ myRole: null }), true)
    ).toEqual(["manageMembers", "archive", "delete"]);
  });

  it("never offers leave on a private channel the viewer is not in", () => {
    expect(
      buildChannelActionKinds(
        makeChannel({ visibility: "private", myRole: null }),
        true
      )
    ).toEqual(["manageMembers", "archive", "delete"]);
  });

  it("gates archived-row actions to managers/admins", () => {
    const archived = makeChannel({ archivedAt: "2026-07-30T01:00:00Z" });
    expect(buildArchivedChannelActionKinds(archived, false)).toEqual([]);
    expect(
      buildArchivedChannelActionKinds(
        makeChannel({ archivedAt: "x", myRole: "manager" }),
        false
      )
    ).toEqual(["unarchive"]);
    expect(buildArchivedChannelActionKinds(archived, true)).toEqual([
      "unarchive",
      "delete",
    ]);
  });
});

describe("archived subgroup", () => {
  const archived = makeChannel({
    id: "ch-arch",
    name: "old-plans",
    archivedAt: "2026-07-30T01:00:00Z",
    myRole: "manager",
  });

  it("is absent while no archived channels exist", () => {
    const items = buildCloudChannelsMenuItems(
      buildParams({ channels: [makeChannel()] })
    );
    expect(
      items.some((item) => item.id === CLOUD_CHANNELS_ARCHIVED_GROUP_ID)
    ).toBe(false);
  });

  it("renders a trailing group whose rows carry unarchive/delete actions", () => {
    const onUnarchive = vi.fn();
    const onDeleteChannel = vi.fn();
    const items = buildCloudChannelsMenuItems(
      buildParams({
        channels: [makeChannel()],
        archivedChannels: [archived],
        isOrgAdmin: true,
        onUnarchive,
        onDeleteChannel,
      })
    );
    const group = items[items.length - 1];
    expect(group.id).toBe(CLOUD_CHANNELS_ARCHIVED_GROUP_ID);
    // Group header (no navigableParent): the NavigationMenu primitive keeps
    // it collapsed until the user toggles it.
    expect(group.navigableParent).toBeUndefined();
    expect(group.children).toHaveLength(1);
    const row = group.children?.[0];
    expect(row?.dataTestId).toBe("sidebar-cloud-channel-ch-arch");
    const [unarchiveAction, deleteAction] = row?.rowActions ?? [];
    expect(unarchiveAction?.dataTestId).toBe("cloud-channel-unarchive-ch-arch");
    expect(deleteAction?.dataTestId).toBe("cloud-channel-delete-ch-arch");
    unarchiveAction?.onClick({} as never);
    deleteAction?.onClick({} as never);
    expect(onUnarchive).toHaveBeenCalledWith(archived);
    expect(onDeleteChannel).toHaveBeenCalledWith(archived);
  });

  it("gives a plain member's archived rows no hover actions", () => {
    const items = buildCloudChannelsMenuItems(
      buildParams({
        archivedChannels: [makeChannel({ archivedAt: "x", myRole: "member" })],
      })
    );
    const row = items[items.length - 1].children?.[0];
    expect(row?.rowActions).toBeUndefined();
    expect(row?.showMoreActions).toBeUndefined();
  });
});

describe("empty/loading/error states", () => {
  it("shows a clickable muted create row when ready with zero channels", () => {
    const items = buildCloudChannelsMenuItems(buildParams());
    const emptyRow = items[1];
    expect(emptyRow.id).toBe(CLOUD_CHANNELS_EMPTY_ID);
    expect(emptyRow.label).toBe("cloud.channels.createFirst");
    expect(emptyRow.visualTone).toBe("secondary");
    expect(emptyRow.disabled).toBeUndefined();
  });

  it("funnels loading and error into a disabled placeholder row", () => {
    const loading = buildCloudChannelsMenuItems(
      buildParams({ phase: "loading" })
    )[1];
    expect(loading.label).toBe("cloud.orgPanel.loading");
    expect(loading.disabled).toBe(true);

    const error = buildCloudChannelsMenuItems(
      buildParams({ phase: "error" })
    )[1];
    expect(error.label).toBe("cloud.channels.loadError");
    expect(error.disabled).toBe(true);
  });
});

describe("menu item id ownership", () => {
  it("claims exactly the section's own ids", () => {
    expect(isCloudChannelsMenuItemId("separator-cloud-channels")).toBe(true);
    expect(isCloudChannelsMenuItemId(CLOUD_CHANNELS_EMPTY_ID)).toBe(true);
    expect(isCloudChannelsMenuItemId(CLOUD_CHANNELS_ARCHIVED_GROUP_ID)).toBe(
      true
    );
    expect(
      isCloudChannelsMenuItemId(buildCloudChannelRowId("org-1", "ch-1"))
    ).toBe(true);
    expect(isCloudChannelsMenuItemId("cloudremote-org-1|row-1")).toBe(false);
    expect(isCloudChannelsMenuItemId("separator-cloud-team-sessions")).toBe(
      false
    );
    expect(isCloudChannelsMenuItemId("cloud-team-sessions-next-page")).toBe(
      false
    );
  });
});
