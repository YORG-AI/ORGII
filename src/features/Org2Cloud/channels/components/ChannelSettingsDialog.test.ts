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
import ChannelSettingsDialog from "./ChannelSettingsDialog";

const mocks = vi.hoisted(() => ({
  updateCloudChannel: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../channelsClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../channelsClient")>();
  return { ...actual, updateCloudChannel: mocks.updateCloudChannel };
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
  topic: "review checklist",
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

describe("ChannelSettingsDialog", () => {
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
          createElement(ChannelSettingsDialog, {
            open: true,
            orgId: "org-1",
            channel: CHANNEL,
            onClose: overrides?.onClose ?? vi.fn(),
          })
        )
      );
    });
  }

  function input(testId: string): HTMLInputElement {
    const element = document.querySelector<HTMLInputElement>(
      `[data-testid="${testId}"]`
    );
    expect(element).not.toBeNull();
    return element as HTMLInputElement;
  }

  function typeInto(testId: string, value: string): HTMLInputElement {
    const element = input(testId);
    act(() => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value"
      )?.set;
      valueSetter?.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
    });
    return element;
  }

  async function clickSubmit(): Promise<void> {
    const submit = document.querySelector<HTMLButtonElement>(
      '[data-testid="channel-settings-submit"]'
    );
    expect(submit).not.toBeNull();
    await act(async () => {
      submit?.click();
    });
    await flushAsync();
  }

  function errorText(): string | undefined {
    return (
      document.querySelector('[data-testid="channel-settings-error"]')
        ?.textContent ?? undefined
    );
  }

  it("seeds the form from the channel and closes without any RPC when nothing changed", async () => {
    const onClose = vi.fn();
    renderDialog({ onClose });

    expect(input("channel-settings-name").value).toBe("code-review");
    expect(input("channel-settings-topic").value).toBe("review checklist");

    await clickSubmit();

    expect(mocks.updateCloudChannel).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(store.get(org2CloudChannelsVersionAtom)["org-1"]).toBeUndefined();
  });

  it("sends ONLY the changed name (normalized), bumps the version, and closes", async () => {
    mocks.updateCloudChannel.mockResolvedValue(undefined);
    const onClose = vi.fn();
    renderDialog({ onClose });

    // Live normalization mirrors the create dialog.
    const nameInput = typeInto("channel-settings-name", "#New  Name");
    expect(nameInput.value).toBe("new-name");

    await clickSubmit();

    expect(mocks.updateCloudChannel).toHaveBeenCalledTimes(1);
    expect(mocks.updateCloudChannel).toHaveBeenCalledWith(
      "access",
      "org-1",
      "chan-1",
      { name: "new-name", topic: undefined, postPolicy: undefined }
    );
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(store.get(org2CloudChannelsVersionAtom)["org-1"]).toBe(1);
  });

  it("sends ONLY the changed topic; the empty string clears it (0014 contract)", async () => {
    mocks.updateCloudChannel.mockResolvedValue(undefined);
    renderDialog();

    typeInto("channel-settings-topic", "");
    await clickSubmit();

    expect(mocks.updateCloudChannel).toHaveBeenCalledWith(
      "access",
      "org-1",
      "chan-1",
      { name: undefined, topic: "", postPolicy: undefined }
    );
  });

  it("maps ORG2_CONFLICT to the name-taken error and preserves the form", async () => {
    mocks.updateCloudChannel.mockRejectedValue(
      new Org2CloudChannelsError("cloud_update_channel: ORG2_CONFLICT", 409)
    );
    const onClose = vi.fn();
    renderDialog({ onClose });

    typeInto("channel-settings-name", "taken-name");
    await clickSubmit();

    expect(errorText()).toBe("cloud.channels.create.nameTaken");
    // Failure must NEVER clear the form.
    expect(input("channel-settings-name").value).toBe("taken-name");
    expect(input("channel-settings-topic").value).toBe("review checklist");
    expect(onClose).not.toHaveBeenCalled();
    expect(store.get(org2CloudChannelsVersionAtom)["org-1"]).toBeUndefined();
  });

  it("maps ORG2_CHANNEL_MANAGER_REQUIRED to the manager error without closing", async () => {
    mocks.updateCloudChannel.mockRejectedValue(
      new Org2CloudChannelsError(
        "cloud_update_channel: ORG2_CHANNEL_MANAGER_REQUIRED",
        403
      )
    );
    const onClose = vi.fn();
    renderDialog({ onClose });

    typeInto("channel-settings-name", "renamed");
    await clickSubmit();

    expect(errorText()).toBe("cloud.channels.settings.managerRequired");
    expect(input("channel-settings-name").value).toBe("renamed");
    expect(onClose).not.toHaveBeenCalled();
  });
});
