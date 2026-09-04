// @vitest-environment jsdom
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

import type { PairingInitOutput } from "@src/api/tauri/mobileRemote";

import MobileRemoteSettingsSection from "../MobileRemoteSettingsSection";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

const mocks = vi.hoisted(() => ({
  error: vi.fn(),
  pairComplete: vi.fn(),
  pairInit: vi.fn(),
  refresh: vi.fn(),
  revokeDevice: vi.fn(),
  settings: new Map<string, unknown>(),
  success: vi.fn(),
  syncDevices: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { seconds?: number }) =>
      values?.seconds == null ? key : `${key}:${values.seconds}`,
  }),
}));

vi.mock("@src/api/tauri/mobileRemote", () => ({
  mobileRemoteApi: {
    getRelayStatus: vi.fn(),
    pairComplete: mocks.pairComplete,
    pairInit: mocks.pairInit,
    revokeDevice: mocks.revokeDevice,
    syncDevices: mocks.syncDevices,
  },
  PERMISSION_TIER: { FULL: "full", READ_ONLY: "read_only" },
}));

vi.mock("@src/components/Message", () => ({
  default: { error: mocks.error, success: mocks.success },
}));

vi.mock("@src/hooks/settings/useSettings", () => ({
  useSetting: (key: string) => [mocks.settings.get(key), vi.fn()],
}));

vi.mock("@src/hooks/async", () => ({
  useAsyncData: <T>({ initialData }: { initialData: T }) => ({
    data: initialData,
    error: null,
    loading: false,
    refresh: mocks.refresh,
  }),
}));

const firstPairing: PairingInitOutput = {
  pairingCode: "PAIR-1",
  confirmationPhrase: "ember-delta-coral",
  qrPayload: "https://relay.example.test/orgii/mobile#pair=first",
  expiresInSeconds: 120,
};

const secondPairing: PairingInitOutput = {
  pairingCode: "PAIR-2",
  confirmationPhrase: "harbor-amber-grove",
  qrPayload: "https://relay.example.test/orgii/mobile#pair=second",
  expiresInSeconds: 120,
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Missing button: ${label}`);
  }
  return button;
}

describe("MobileRemoteSettingsSection outdoor pairing", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.settings.clear();
    mocks.settings.set("mobileRemote.enabled", true);
    mocks.settings.set("mobileRemote.relayEnabled", true);
    mocks.settings.set(
      "mobileRemote.relayUrl",
      "wss://relay.example.test/v1/mobile/ws"
    );
    mocks.settings.set("mobileRemote.desktopToken", "123456789012345678901234");
    mocks.settings.set("mobileRemote.allowLanExposure", false);
    mocks.settings.set("mobileRemote.lanToken", "lan-token");
    mocks.settings.set("mobileRemote.lanPort", 13847);
    mocks.error.mockReset();
    mocks.pairComplete.mockReset();
    mocks.pairInit.mockReset();
    mocks.refresh.mockReset();
    mocks.revokeDevice.mockReset();
    mocks.success.mockReset();
    mocks.syncDevices.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  async function renderSection(): Promise<void> {
    await act(async () => {
      root.render(createElement(MobileRemoteSettingsSection));
    });
  }

  it("reveals the copyable payload after generation and preserves it during regeneration", async () => {
    const firstRequest = deferred<PairingInitOutput>();
    const secondRequest = deferred<PairingInitOutput>();
    mocks.pairInit
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(secondRequest.promise);
    await renderSection();

    const startButton = findButton(
      container,
      "mobileRemote.startOutdoorPairing"
    );
    act(() => startButton.click());
    expect(startButton.disabled).toBe(true);
    expect(
      container.querySelector("#mobile-remote-pairing-payload")
    ).toBeNull();

    await act(async () => firstRequest.resolve(firstPairing));
    expect(mocks.pairInit).toHaveBeenNthCalledWith(1, {
      isPrimary: true,
      label: "My phone",
      tier: "full",
    });
    expect(
      container.querySelector<HTMLTextAreaElement>(
        "#mobile-remote-pairing-payload"
      )?.value
    ).toBe(firstPairing.qrPayload);

    act(() => {
      findButton(container, "mobileRemote.regeneratePairing").click();
    });
    expect(
      container.querySelector<HTMLTextAreaElement>(
        "#mobile-remote-pairing-payload"
      )?.value
    ).toBe(firstPairing.qrPayload);
    expect(
      findButton(container, "mobileRemote.copyPairingPayload").disabled
    ).toBe(true);

    await act(async () => secondRequest.resolve(secondPairing));
    expect(
      container.querySelector<HTMLTextAreaElement>(
        "#mobile-remote-pairing-payload"
      )?.value
    ).toBe(secondPairing.qrPayload);
  });

  it("ignores a stale pairing response after the relay scope changes", async () => {
    const request = deferred<PairingInitOutput>();
    mocks.pairInit.mockReturnValue(request.promise);
    await renderSection();
    act(() => {
      findButton(container, "mobileRemote.startOutdoorPairing").click();
    });

    mocks.settings.set(
      "mobileRemote.relayUrl",
      "wss://other-relay.example.test/v1/mobile/ws"
    );
    await renderSection();
    await act(async () => request.resolve(firstPairing));

    expect(
      container.querySelector("#mobile-remote-pairing-payload")
    ).toBeNull();
    expect(container.textContent).toContain("mobileRemote.startOutdoorPairing");
  });
});
