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

import { org2CloudAuthAtom } from "../../org2CloudAuthAtom";
import { org2CloudChannelsVersionAtom } from "../channelsAtom";
import { Org2CloudChannelsError } from "../channelsClient";
import type { CloudChannel, CloudChannelMember } from "../types";
import ManageChannelMembersDialog from "./ManageChannelMembersDialog";

const mocks = vi.hoisted(() => ({
  listCloudChannelMembers: vi.fn(),
  addCloudChannelMembers: vi.fn(),
  removeCloudChannelMember: vi.fn(),
  setCloudChannelMemberRole: vi.fn(),
  loadCloudOrgMembers: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../channelsClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../channelsClient")>();
  return {
    ...actual,
    listCloudChannelMembers: mocks.listCloudChannelMembers,
    addCloudChannelMembers: mocks.addCloudChannelMembers,
    removeCloudChannelMember: mocks.removeCloudChannelMember,
    setCloudChannelMemberRole: mocks.setCloudChannelMemberRole,
  };
});

vi.mock("../../org2CloudMembersCoordinator", () => ({
  loadCloudOrgMembers: mocks.loadCloudOrgMembers,
}));

const AUTH = {
  kind: "org2_cloud" as const,
  supabaseUrl: "https://cloud.example.test",
  supabaseAnonKey: "anon",
  userId: "user-self",
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: 4_102_444_800,
};

const CHANNEL: CloudChannel = {
  id: "chan-1",
  name: "secret-plans",
  topic: undefined,
  visibility: "private",
  postPolicy: "everyone",
  createdBy: "user-self",
  createdAt: "2026-07-31T00:00:00.000Z",
  updatedAt: undefined,
  archivedAt: null,
  messageCount: 0,
  lastMessageAt: undefined,
  memberCount: 1,
  myRole: "manager",
};

const SELF_MANAGER: CloudChannelMember = {
  userId: "user-self",
  displayName: "Me",
  avatarUrl: undefined,
  role: "manager",
  addedAt: undefined,
};

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

async function flushAsync(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("ManageChannelMembersDialog", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createStore>;

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadCloudOrgMembers.mockResolvedValue({ auth: AUTH, members: [] });
    store = createStore();
    store.set(org2CloudAuthAtom, AUTH);
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

  async function renderDialog(overrides?: {
    onClose?: () => void;
    canManage?: boolean;
  }) {
    await act(async () => {
      root.render(
        createElement(
          Provider,
          { store },
          createElement(ManageChannelMembersDialog, {
            open: true,
            orgId: "org-1",
            channel: CHANNEL,
            currentUserId: "user-self",
            canManage: overrides?.canManage ?? true,
            onClose: overrides?.onClose ?? vi.fn(),
          })
        )
      );
    });
    await flushAsync();
  }

  it("lists members with a manager badge and a self leave action", async () => {
    mocks.listCloudChannelMembers.mockResolvedValue([SELF_MANAGER]);
    await renderDialog();

    expect(mocks.listCloudChannelMembers).toHaveBeenCalledWith(
      "access",
      "org-1",
      "chan-1"
    );
    expect(
      document.querySelector('[data-testid="channel-member-row-user-self"]')
    ).not.toBeNull();
    expect(
      document.querySelector(
        '[data-testid="channel-member-manager-badge-user-self"]'
      )?.textContent
    ).toBe("cloud.channels.members.managerBadge");
    // Private channel: the current user's row offers "Leave channel".
    expect(
      document.querySelector('[data-testid="channel-member-leave"]')
    ).not.toBeNull();
  });

  it("surfaces ORG2_LAST_MANAGER as the assign-another-manager message", async () => {
    mocks.listCloudChannelMembers.mockResolvedValue([SELF_MANAGER]);
    mocks.removeCloudChannelMember.mockRejectedValue(
      new Org2CloudChannelsError(
        "cloud_remove_channel_member: ORG2_LAST_MANAGER",
        409
      )
    );
    const onClose = vi.fn();
    await renderDialog({ onClose });

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="channel-member-leave"]'
        )
        ?.click();
    });
    await flushAsync();

    expect(mocks.removeCloudChannelMember).toHaveBeenCalledWith(
      "access",
      "org-1",
      "chan-1",
      "user-self"
    );
    expect(
      document.querySelector('[data-testid="channel-members-error"]')
        ?.textContent
    ).toBe("cloud.channels.members.lastManager");
    // A failed leave never closes the dialog or bumps the listings version.
    expect(onClose).not.toHaveBeenCalled();
    expect(store.get(org2CloudChannelsVersionAtom)["org-1"]).toBeUndefined();
  });

  it("adds selected roster members, bumps the version, and refreshes the list", async () => {
    mocks.listCloudChannelMembers.mockResolvedValue([SELF_MANAGER]);
    mocks.addCloudChannelMembers.mockResolvedValue(undefined);
    mocks.loadCloudOrgMembers.mockResolvedValue({
      auth: AUTH,
      members: [
        { userId: "user-self", role: "owner", status: "active" },
        {
          userId: "user-2",
          displayName: "Cara",
          role: "member",
          status: "active",
        },
        {
          userId: "user-3",
          displayName: "Gone",
          role: "member",
          status: "removed",
        },
      ],
    });
    await renderDialog();

    // Only active roster members outside the channel are addable.
    expect(
      document.querySelector('[data-testid="channel-members-add-user-3"]')
    ).toBeNull();
    const addRowLabel = document.querySelector<HTMLLabelElement>(
      '[data-testid="channel-members-add-user-2"] label'
    );
    expect(addRowLabel).not.toBeNull();
    act(() => {
      addRowLabel?.click();
    });

    await act(async () => {
      const submit = document.querySelector<HTMLButtonElement>(
        '[data-testid="channel-members-add-submit"]'
      );
      expect(submit?.closest(".liquid-modal-body")).toBeNull();
      submit?.click();
    });
    await flushAsync();

    expect(mocks.addCloudChannelMembers).toHaveBeenCalledWith(
      "access",
      "org-1",
      "chan-1",
      ["user-2"]
    );
    expect(store.get(org2CloudChannelsVersionAtom)["org-1"]).toBe(1);
    // Success refreshes the member list (initial load + post-mutation).
    expect(mocks.listCloudChannelMembers).toHaveBeenCalledTimes(2);
  });

  it("hides the add-members section for non-managers", async () => {
    mocks.listCloudChannelMembers.mockResolvedValue([SELF_MANAGER]);
    await renderDialog({ canManage: false });

    expect(
      document.querySelector('[data-testid="channel-members-add-submit"]')
    ).toBeNull();
    expect(
      document.querySelector('[data-testid="channel-member-actions-user-self"]')
    ).toBeNull();
    expect(mocks.loadCloudOrgMembers).not.toHaveBeenCalled();
  });
});
