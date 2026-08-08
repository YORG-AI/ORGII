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
import type { CloudChannel } from "../types";
import CreateChannelDialog from "./CreateChannelDialog";

const mocks = vi.hoisted(() => ({
  createCloudChannel: vi.fn(),
  loadCloudOrgMembers: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../channelsClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../channelsClient")>();
  return { ...actual, createCloudChannel: mocks.createCloudChannel };
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
  // Far future: ensureFreshSession returns this state without a network hop.
  expiresAt: 4_102_444_800,
};

const CREATED_CHANNEL: CloudChannel = {
  id: "chan-1",
  name: "code-review",
  topic: undefined,
  visibility: "org",
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

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

async function flushAsync(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("CreateChannelDialog", () => {
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

  function renderDialog(overrides?: { onClose?: () => void }) {
    act(() => {
      root.render(
        createElement(
          Provider,
          { store },
          createElement(CreateChannelDialog, {
            open: true,
            orgId: "org-1",
            onClose: overrides?.onClose ?? vi.fn(),
          })
        )
      );
    });
  }

  function typeName(value: string) {
    const input = document.querySelector<HTMLInputElement>(
      '[data-testid="channel-create-name"]'
    );
    expect(input).not.toBeNull();
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set;
      valueSetter?.call(input, value);
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    return input as HTMLInputElement;
  }

  it("live-normalizes the name and submits the normalized value", async () => {
    mocks.createCloudChannel.mockResolvedValue(CREATED_CHANNEL);
    const onClose = vi.fn();
    renderDialog({ onClose });

    // Slack behavior: leading '#' stripped, lowercased, spaces → hyphens.
    const input = typeName("#Code  Review");
    expect(input.value).toBe("code-review");

    const submit = document.querySelector<HTMLButtonElement>(
      '[data-testid="channel-create-submit"]'
    );
    expect(submit?.disabled).toBe(false);
    expect(submit?.closest(".liquid-modal-body")).toBeNull();
    await act(async () => {
      submit?.click();
    });
    await flushAsync();

    expect(mocks.createCloudChannel).toHaveBeenCalledTimes(1);
    expect(mocks.createCloudChannel).toHaveBeenCalledWith("access", "org-1", {
      name: "code-review",
      topic: undefined,
      visibility: "org",
      postPolicy: "everyone",
      memberUserIds: undefined,
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    // Every successful mutation bumps the per-org version so listings refetch.
    expect(store.get(org2CloudChannelsVersionAtom)["org-1"]).toBe(1);
  });

  it("disables submit while the normalized name is empty", () => {
    renderDialog();

    const submit = document.querySelector<HTMLButtonElement>(
      '[data-testid="channel-create-submit"]'
    );
    expect(submit?.disabled).toBe(true);

    // Only hyphens normalizes to the empty string at submit time.
    const input = typeName("---");
    expect(input.value).toBe("---");
    expect(
      document.querySelector<HTMLButtonElement>(
        '[data-testid="channel-create-submit"]'
      )?.disabled
    ).toBe(true);
  });

  it("shows selected private members in the two-pane picker and submits them", async () => {
    mocks.createCloudChannel.mockResolvedValue({
      ...CREATED_CHANNEL,
      visibility: "private",
      memberCount: 2,
    });
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
      ],
    });
    renderDialog();

    act(() => {
      document
        .querySelector<HTMLInputElement>(
          '[data-testid="channel-create-visibility-private"] input'
        )
        ?.click();
    });
    await flushAsync();

    const memberCheckbox = document.querySelector<HTMLInputElement>(
      '[data-testid="channel-create-member-user-2"] input'
    );
    expect(memberCheckbox).not.toBeNull();
    act(() => memberCheckbox?.click());

    expect(
      document.querySelector('[data-testid="channel-create-selected-count"]')
        ?.textContent
    ).toContain("(1)");
    expect(
      document.querySelector(
        '[data-testid="channel-create-selected-member-user-2"]'
      )?.textContent
    ).toContain("Cara");

    typeName("private-room");
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="channel-create-submit"]'
        )
        ?.click();
    });
    await flushAsync();

    expect(mocks.createCloudChannel).toHaveBeenCalledWith("access", "org-1", {
      name: "private-room",
      topic: undefined,
      visibility: "private",
      postPolicy: "everyone",
      memberUserIds: ["user-2"],
    });
  });

  it("shows the name-taken error on ORG2_CONFLICT and keeps the form intact", async () => {
    mocks.createCloudChannel.mockRejectedValue(
      new Org2CloudChannelsError("cloud_create_channel: ORG2_CONFLICT", 409)
    );
    const onClose = vi.fn();
    renderDialog({ onClose });

    typeName("code-review");
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="channel-create-submit"]'
        )
        ?.click();
    });
    await flushAsync();

    const error = document.querySelector(
      '[data-testid="channel-create-error"]'
    );
    expect(error?.textContent).toBe("cloud.channels.create.nameTaken");
    // Failure must NEVER clear the form.
    expect(
      document.querySelector<HTMLInputElement>(
        '[data-testid="channel-create-name"]'
      )?.value
    ).toBe("code-review");
    expect(onClose).not.toHaveBeenCalled();
    expect(store.get(org2CloudChannelsVersionAtom)["org-1"]).toBeUndefined();
  });

  it("shows the quota error on ORG2_QUOTA_EXCEEDED", async () => {
    mocks.createCloudChannel.mockRejectedValue(
      new Org2CloudChannelsError(
        "cloud_create_channel: ORG2_QUOTA_EXCEEDED",
        429
      )
    );
    renderDialog();

    typeName("overflow");
    await act(async () => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="channel-create-submit"]'
        )
        ?.click();
    });
    await flushAsync();

    expect(
      document.querySelector('[data-testid="channel-create-error"]')
        ?.textContent
    ).toBe("cloud.channels.create.quotaExceeded");
  });
});
