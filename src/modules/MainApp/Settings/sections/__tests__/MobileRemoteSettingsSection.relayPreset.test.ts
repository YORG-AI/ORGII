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

import {
  MOBILE_REMOTE_RELAY_LOCAL_URL,
  MOBILE_REMOTE_RELAY_PRODUCTION_URL,
} from "@src/config/mobileRemoteRelay";

import MobileRemoteSettingsSection from "../MobileRemoteSettingsSection";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

const mocks = vi.hoisted(() => ({
  cloudAuth: null as {
    userId: string;
    profile?: { displayName?: string; primaryEmail?: string };
  } | null,
  navigate: vi.fn(),
  settings: new Map<string, unknown>(),
  setRelayUrl: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: { identity?: string }) => {
      if (values?.identity != null) {
        return `${key}:${values.identity}`;
      }
      return key;
    },
  }),
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock("jotai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jotai")>();
  return {
    ...actual,
    useAtomValue: () => mocks.cloudAuth,
  };
});

vi.mock("@src/features/Org2Cloud/useOrg2CloudSignIn", () => ({
  useOrg2CloudSignIn: () => vi.fn(),
}));

vi.mock("@src/api/tauri/mobileRemote", () => ({
  mobileRemoteApi: {
    getRelayStatus: vi.fn(),
    pairComplete: vi.fn(),
    pairInit: vi.fn(),
    revokeDevice: vi.fn(),
    syncDevices: vi.fn(),
  },
  PERMISSION_TIER: { FULL: "full", READ_ONLY: "read_only" },
}));

vi.mock("@src/components/Message", () => ({
  default: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@src/hooks/settings/useSettings", () => ({
  useSetting: (key: string) => {
    if (key === "mobileRemote.relayUrl") {
      return [mocks.settings.get(key), mocks.setRelayUrl];
    }
    return [mocks.settings.get(key), vi.fn()];
  },
}));

vi.mock("@src/hooks/async", () => ({
  useAsyncData: <T>({ initialData }: { initialData: T }) => ({
    data: initialData,
    error: null,
    loading: false,
    refresh: vi.fn(),
  }),
}));

function findPresetButton(
  container: HTMLElement,
  label: string
): HTMLButtonElement {
  const group = container.querySelector(
    '[data-testid="mobile-remote-relay-preset"]'
  );
  const button = Array.from(group?.querySelectorAll("button") ?? []).find(
    (candidate) => candidate.textContent?.trim() === label
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Missing preset button: ${label}`);
  }
  return button;
}

describe("MobileRemoteSettingsSection relay preset switcher", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.cloudAuth = null;
    mocks.navigate.mockReset();
    mocks.settings.clear();
    mocks.settings.set("mobileRemote.enabled", true);
    mocks.settings.set("mobileRemote.relayEnabled", true);
    mocks.settings.set(
      "mobileRemote.relayUrl",
      MOBILE_REMOTE_RELAY_PRODUCTION_URL
    );
    mocks.settings.set("mobileRemote.desktopToken", "");
    mocks.settings.set("mobileRemote.allowLanExposure", false);
    mocks.settings.set("mobileRemote.lanToken", "lan-token");
    mocks.settings.set("mobileRemote.lanPort", 13847);
    mocks.setRelayUrl.mockReset();
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

  it("reflects the production preset when the relay URL matches production", async () => {
    await renderSection();

    expect(
      findPresetButton(
        container,
        "mobileRemote.relayPresetProduction"
      ).getAttribute("aria-pressed")
    ).toBe("true");
    expect(
      findPresetButton(container, "mobileRemote.relayPresetLocal").getAttribute(
        "aria-pressed"
      )
    ).toBe("false");
  });

  it("shows no selected preset for a custom relay URL", async () => {
    mocks.settings.set(
      "mobileRemote.relayUrl",
      "wss://custom.example.test/v1/mobile/ws"
    );
    await renderSection();

    expect(
      container.querySelector('[data-testid="mobile-remote-relay-preset"]')
    ).not.toBeNull();
    expect(container.querySelector('[aria-pressed="true"]')).toBeNull();
  });

  it("writes the local preset URL when the local segment is clicked", async () => {
    await renderSection();

    act(() => {
      findPresetButton(container, "mobileRemote.relayPresetLocal").click();
    });

    expect(mocks.setRelayUrl).toHaveBeenCalledWith(
      MOBILE_REMOTE_RELAY_LOCAL_URL
    );
  });

  it("prompts for ORG2 Cloud login on production preset when signed out", async () => {
    await renderSection();

    expect(
      container.querySelector('[data-testid="mobile-remote-cloud-sign-in"]')
    ).not.toBeNull();
    expect(container.textContent).toContain("mobileRemote.cloudLoginTitle");
    expect(container.textContent).toContain(
      "mobileRemote.cloudLoginDescSignedOut"
    );
    expect(container.textContent).not.toContain("mobileRemote.desktopToken");
  });

  it("shows cloud identity instead of desktop token on production preset when signed in", async () => {
    mocks.cloudAuth = {
      userId: "user-1",
      profile: { displayName: "Junyu" },
    };
    await renderSection();

    expect(
      container.querySelector('[data-testid="mobile-remote-cloud-sign-in"]')
    ).toBeNull();
    expect(container.textContent).toContain(
      "mobileRemote.cloudLoginDescSignedIn:Junyu"
    );
    expect(container.textContent).not.toContain("mobileRemote.desktopToken");
  });

  it("shows the desktop token field for the local preset", async () => {
    mocks.settings.set("mobileRemote.relayUrl", MOBILE_REMOTE_RELAY_LOCAL_URL);
    mocks.settings.set("mobileRemote.desktopToken", "123456789012345678901234");
    await renderSection();

    expect(container.textContent).toContain("mobileRemote.desktopToken");
    expect(
      container.querySelector('[data-testid="mobile-remote-cloud-sign-in"]')
    ).toBeNull();
  });

  it("disables outdoor pairing until ORG2 Cloud login on production preset", async () => {
    await renderSection();

    const pairingButton = Array.from(container.querySelectorAll("button")).find(
      (candidate) =>
        candidate.textContent?.trim() === "mobileRemote.startOutdoorPairing"
    );
    expect(pairingButton?.disabled).toBe(true);
  });
});
