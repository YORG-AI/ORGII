// @vitest-environment jsdom
/**
 * Regression for the org-switch create-draft fix: `useCloudChannelsSection`
 * keys `CreateChannelDialog` per org, so a draft typed under org A survives
 * close/reopen WITHIN that org but is dropped when the active org switches
 * (a private-member selection from org A's roster would otherwise ride along
 * invisibly and fail every submit in org B with ORG2_VALIDATION).
 */
import { Provider, createStore } from "jotai";
import { Fragment, type MouseEvent, act, createElement } from "react";
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

import { bumpOrg2CloudChannelsVersionAtom } from "@src/features/Org2Cloud/channels/channelsAtom";
import type { CloudChannel } from "@src/features/Org2Cloud/channels/types";
import { org2CloudAuthAtom } from "@src/features/Org2Cloud/org2CloudAuthAtom";
import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";

import { useCloudChannelsSection } from "./channelsSection";
import { CLOUD_CHANNELS_EMPTY_ID } from "./channelsSection.menuItems";

const mocks = vi.hoisted(() => ({
  listCloudChannels: vi.fn(),
  getCloudCapabilities: vi.fn(),
  loadCloudOrgMembers: vi.fn(),
  menuNew: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@tauri-apps/api/menu", () => ({
  Menu: { new: mocks.menuNew },
}));

vi.mock(
  "@src/features/Org2Cloud/channels/channelsClient",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@src/features/Org2Cloud/channels/channelsClient")
      >();
    return { ...actual, listCloudChannels: mocks.listCloudChannels };
  }
);

vi.mock("@src/features/Org2Cloud/org2CloudCapabilities", () => ({
  getCloudCapabilities: mocks.getCloudCapabilities,
}));

vi.mock("@src/features/Org2Cloud/org2CloudMembersCoordinator", () => ({
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

const CHANNEL: CloudChannel = {
  id: "channel-1",
  name: "release-notes",
  topic: "Ship status",
  visibility: "org",
  postPolicy: "everyone",
  myRole: "manager",
  messageCount: 0,
  memberCount: 1,
  createdBy: AUTH.userId,
  createdAt: "2026-07-30T00:00:00.000Z",
  updatedAt: "2026-07-30T00:00:00.000Z",
  archivedAt: null,
};

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

async function flushAsync(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * Renders the section's dialogs plus a button wired to the section's own
 * click resolver for the ready-and-empty "Create a channel" row (render-pure
 * probe — no module-variable capture).
 */
function Probe(props: { orgId: string | null }) {
  const section = useCloudChannelsSection({ orgId: props.orgId });
  const channelRow = section.channelsMenuItems.find((item) =>
    item.id.startsWith("cloud-channel-")
  );
  return createElement(
    Fragment,
    null,
    createElement("button", {
      "data-testid": "probe-open-create",
      onClick: () =>
        section.handleChannelsItemClick({
          id: CLOUD_CHANNELS_EMPTY_ID,
          key: CLOUD_CHANNELS_EMPTY_ID,
          label: "",
        } as NavigationMenuItem),
    }),
    createElement("button", {
      "data-testid": "probe-open-channel-actions",
      onClick: (event: MouseEvent<HTMLButtonElement>) =>
        channelRow?.rowActions?.[0]?.onClick(event),
    }),
    section.channelsDialogs
  );
}

describe("useCloudChannelsSection create-dialog org keying", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createStore>;

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.getCloudCapabilities.mockResolvedValue({ orgChannels: true });
    mocks.menuNew.mockResolvedValue({ popup: vi.fn(), close: vi.fn() });
    mocks.listCloudChannels.mockResolvedValue({
      channels: [],
      serverTime: undefined,
    });
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

  function renderSection(orgId: string | null) {
    act(() => {
      root.render(
        createElement(Provider, { store }, createElement(Probe, { orgId }))
      );
    });
  }

  function openCreateDialog() {
    act(() => {
      document
        .querySelector<HTMLButtonElement>('[data-testid="probe-open-create"]')
        ?.click();
    });
  }

  function nameInput(): HTMLInputElement | null {
    return document.querySelector<HTMLInputElement>(
      '[data-testid="channel-create-name"]'
    );
  }

  function typeName(value: string) {
    const input = nameInput();
    expect(input).not.toBeNull();
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set;
      valueSetter?.call(input, value);
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("keeps the create draft across close/reopen within an org but drops it on org switch", async () => {
    renderSection("org-a");
    await flushAsync();

    // Open the create dialog via the section's own click resolver.
    openCreateDialog();
    expect(nameInput()).not.toBeNull();
    typeName("draft-name");
    expect(nameInput()?.value).toBe("draft-name");

    // Close: the dialog unmounts its modal but keeps component state.
    act(() => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="channel-create-cancel"]'
        )
        ?.click();
    });
    expect(nameInput()).toBeNull();

    // Reopen in the SAME org: the draft is still there.
    openCreateDialog();
    expect(nameInput()?.value).toBe("draft-name");

    // Switch org: the per-org key remounts the dialog and drops the draft.
    renderSection("org-b");
    await flushAsync();
    openCreateDialog();
    expect(nameInput()?.value).toBe("");
  });

  it("closes an open create dialog when the org switches", async () => {
    renderSection("org-a");
    await flushAsync();

    openCreateDialog();
    expect(nameInput()).not.toBeNull();

    // The dialog-state stamp for org A goes stale on switch: nothing may
    // stay open for org B without an explicit reopen.
    renderSection("org-b");
    await flushAsync();
    expect(nameInput()).toBeNull();
  });

  it("closes a channel-bound dialog when the authoritative list loses the channel", async () => {
    mocks.listCloudChannels.mockResolvedValue({
      channels: [CHANNEL],
      serverTime: undefined,
    });
    renderSection("org-a");
    await flushAsync();

    act(() => {
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="probe-open-channel-actions"]'
        )
        ?.click();
    });
    await flushAsync();
    const settingsEntry = mocks.menuNew.mock.calls
      .flatMap(
        ([options]) =>
          (
            options as {
              items?: Array<{ text?: string; action?: () => void }>;
            }
          ).items ?? []
      )
      .find((entry) => entry.text === "cloud.channels.settings.action");
    expect(settingsEntry?.action).toBeTypeOf("function");
    act(() => settingsEntry?.action?.());
    expect(
      document.querySelector('[data-testid="channel-settings-dialog"]')
    ).not.toBeNull();

    mocks.listCloudChannels.mockResolvedValue({
      channels: [],
      serverTime: undefined,
    });
    act(() => {
      store.set(bumpOrg2CloudChannelsVersionAtom, "org-a");
    });
    await flushAsync();

    expect(
      document.querySelector('[data-testid="channel-settings-dialog"]')
    ).toBeNull();
  });
});
