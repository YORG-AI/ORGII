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
import ArchiveChannelDialog from "./ArchiveChannelDialog";

const mocks = vi.hoisted(() => ({
  archiveCloudChannel: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../channelsClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../channelsClient")>();
  return { ...actual, archiveCloudChannel: mocks.archiveCloudChannel };
});

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
  id: "chan-1",
  name: "code-review",
  topic: undefined,
  visibility: "org",
  postPolicy: "everyone",
  createdBy: "user-self",
  createdAt: "2026-07-31T00:00:00.000Z",
  updatedAt: undefined,
  archivedAt: null,
  messageCount: 3,
  lastMessageAt: undefined,
  memberCount: 2,
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

describe("ArchiveChannelDialog", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createStore>;

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.clearAllMocks();
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
          createElement(ArchiveChannelDialog, {
            open: true,
            orgId: "org-1",
            channel: CHANNEL,
            onClose: overrides?.onClose ?? vi.fn(),
          })
        )
      );
    });
  }

  async function clickConfirm(): Promise<void> {
    const confirm = document.querySelector<HTMLButtonElement>(
      '[data-testid="channel-archive-confirm"]'
    );
    expect(confirm).not.toBeNull();
    await act(async () => {
      confirm?.click();
    });
    await flushAsync();
  }

  function errorText(): string | undefined {
    return (
      document.querySelector('[data-testid="channel-archive-error"]')
        ?.textContent ?? undefined
    );
  }

  it("archives the channel, bumps the org's version, and closes", async () => {
    mocks.archiveCloudChannel.mockResolvedValue("2026-07-31T01:00:00.000Z");
    const onClose = vi.fn();
    renderDialog({ onClose });

    await clickConfirm();

    expect(mocks.archiveCloudChannel).toHaveBeenCalledTimes(1);
    expect(mocks.archiveCloudChannel).toHaveBeenCalledWith(
      "access",
      "org-1",
      "chan-1"
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(store.get(org2CloudChannelsVersionAtom)["org-1"]).toBe(1);
  });

  it("surfaces ORG2_CHANNEL_MANAGER_REQUIRED as the managers-only inline error", async () => {
    mocks.archiveCloudChannel.mockRejectedValue(
      new Org2CloudChannelsError(
        "cloud_archive_channel: ORG2_CHANNEL_MANAGER_REQUIRED",
        403
      )
    );
    const onClose = vi.fn();
    renderDialog({ onClose });

    await clickConfirm();

    expect(errorText()).toBe("cloud.channels.archive.managerRequired");
    expect(onClose).not.toHaveBeenCalled();
    // A failed archive must not invalidate listings.
    expect(store.get(org2CloudChannelsVersionAtom)["org-1"]).toBeUndefined();
  });

  it("maps any other failure to the generic inline error without closing", async () => {
    mocks.archiveCloudChannel.mockRejectedValue(new Error("boom"));
    const onClose = vi.fn();
    renderDialog({ onClose });

    await clickConfirm();

    expect(errorText()).toBe("cloud.channels.archive.error");
    expect(onClose).not.toHaveBeenCalled();
    expect(store.get(org2CloudChannelsVersionAtom)["org-1"]).toBeUndefined();
  });
});
