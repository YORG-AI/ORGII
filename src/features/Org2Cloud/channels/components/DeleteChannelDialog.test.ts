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
import DeleteChannelDialog from "./DeleteChannelDialog";

const mocks = vi.hoisted(() => ({
  deleteCloudChannel: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../channelsClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../channelsClient")>();
  return { ...actual, deleteCloudChannel: mocks.deleteCloudChannel };
});

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

describe("DeleteChannelDialog", () => {
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
          createElement(DeleteChannelDialog, {
            open: true,
            orgId: "org-1",
            channel: CHANNEL,
            onClose: overrides?.onClose ?? vi.fn(),
          })
        )
      );
    });
  }

  function deleteButton(): HTMLButtonElement | null {
    return document.querySelector<HTMLButtonElement>(
      '[data-testid="channel-delete-confirm"]'
    );
  }

  function toggleAcknowledge() {
    const label = document.querySelector<HTMLLabelElement>(
      '[data-testid="channel-delete-acknowledge"] label'
    );
    expect(label).not.toBeNull();
    act(() => {
      label?.click();
    });
  }

  it("keeps the danger action disabled until the acknowledgement is checked", async () => {
    mocks.deleteCloudChannel.mockResolvedValue(undefined);
    const onClose = vi.fn();
    renderDialog({ onClose });

    expect(deleteButton()?.disabled).toBe(true);

    // Clicking delete while disabled must be a no-op.
    await act(async () => {
      deleteButton()?.click();
    });
    await flushAsync();
    expect(mocks.deleteCloudChannel).not.toHaveBeenCalled();

    toggleAcknowledge();
    expect(deleteButton()?.disabled).toBe(false);

    await act(async () => {
      deleteButton()?.click();
    });
    await flushAsync();

    expect(mocks.deleteCloudChannel).toHaveBeenCalledTimes(1);
    expect(mocks.deleteCloudChannel).toHaveBeenCalledWith(
      "access",
      "org-1",
      "chan-1"
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(store.get(org2CloudChannelsVersionAtom)["org-1"]).toBe(1);
  });

  it("unchecking the acknowledgement disables the action again", () => {
    renderDialog();

    toggleAcknowledge();
    expect(deleteButton()?.disabled).toBe(false);
    toggleAcknowledge();
    expect(deleteButton()?.disabled).toBe(true);
  });

  it("surfaces ORG2_ADMIN_REQUIRED as the admins-only inline error", async () => {
    mocks.deleteCloudChannel.mockRejectedValue(
      new Org2CloudChannelsError(
        "cloud_delete_channel: ORG2_ADMIN_REQUIRED",
        403
      )
    );
    const onClose = vi.fn();
    renderDialog({ onClose });

    toggleAcknowledge();
    await act(async () => {
      deleteButton()?.click();
    });
    await flushAsync();

    expect(
      document.querySelector('[data-testid="channel-delete-error"]')
        ?.textContent
    ).toBe("cloud.channels.delete.adminRequired");
    expect(onClose).not.toHaveBeenCalled();
    expect(store.get(org2CloudChannelsVersionAtom)["org-1"]).toBeUndefined();
  });
});
