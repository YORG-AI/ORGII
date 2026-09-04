// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { DevicesTab, derivePairedDesktopsFromInventory } from "./DevicesTab";

const mocks = vi.hoisted(() => ({ switchPairedDesktop: vi.fn() }));
const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

vi.mock("../../app", () => ({
  useMobileRemote: () => ({
    connection: {
      desktopId: "desktop-1",
      desktopName: "Home Mac",
      presence: "online",
    },
    pairedDesktops: [
      {
        id: "desktop-1",
        name: "Home Mac",
        active: true,
        updatedAtMs: 1,
      },
      {
        id: "desktop-2",
        name: "Office Mac",
        active: false,
        updatedAtMs: 2,
      },
    ],
    switchPairedDesktop: mocks.switchPairedDesktop,
  }),
}));

const translations: Record<string, string> = {
  "devices.title": "Devices",
  "devices.thisDevice": "This device",
  "devices.thisDeviceLabel": "ORGII Mobile",
  "devices.thisDeviceSubtitle": "Full remote · Active now",
  "devices.pairedDesktops": "Paired desktops",
  "devices.primary": "Primary",
  "devices.online": "Online",
  "devices.offline": "Offline",
  "devices.unknown": "Connecting",
  "devices.switchTo": "Switch to Office Mac",
  "devices.switchFailed": "Could not switch desktops",
  "devices.emptyDesktops": "No paired desktops",
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => translations[key] ?? key,
  }),
}));

describe("DevicesTab", () => {
  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  afterEach(() => {
    mocks.switchPairedDesktop.mockReset();
  });

  it("uses shared section rows, icons, and status presentation", () => {
    const html = renderToStaticMarkup(React.createElement(DevicesTab));

    expect(html).toContain('data-testid="mobile-remote-this-device"');
    expect(html).toContain('data-testid="mobile-remote-paired-desktops"');
    expect(html).toContain("section-layout-row");
    expect(html).toContain("Home Mac");
    expect(html).toContain("Primary");
    expect(html).toContain("Online");
    expect(html).toContain("bg-success-6");
  });

  it("does not invent paired devices from the transient connection", () => {
    expect(
      derivePairedDesktopsFromInventory({
        desktops: [],
        activePresence: "online",
      })
    ).toEqual([]);
  });

  it("keeps inactive local pairings visible but offline", () => {
    expect(
      derivePairedDesktopsFromInventory({
        desktops: [
          {
            id: "desktop-old",
            name: "Office Mac",
            active: false,
            updatedAtMs: 1,
          },
        ],
        activePresence: "online",
      })
    ).toEqual([
      {
        id: "desktop-old",
        name: "Office Mac",
        presence: "offline",
        primary: false,
      },
    ]);
  });

  it("routes an inactive desktop row through the shared switch action", async () => {
    mocks.switchPairedDesktop.mockResolvedValue(undefined);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(React.createElement(DevicesTab)));
      const button = Array.from(container.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.includes("Office Mac")
      );
      expect(button).toBeTruthy();
      act(() => button?.click());
      expect(mocks.switchPairedDesktop).toHaveBeenCalledWith("desktop-2");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it("disables every desktop row and marks the selected row busy while switching", async () => {
    let resolveSwitch!: () => void;
    const pendingSwitch = new Promise<void>((resolve) => {
      resolveSwitch = resolve;
    });
    mocks.switchPairedDesktop.mockReturnValue(pendingSwitch);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(React.createElement(DevicesTab)));
      const officeButton = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Switch to Office Mac"]'
      );
      expect(officeButton).toBeTruthy();

      act(() => officeButton?.click());

      const buttons = Array.from(container.querySelectorAll("button"));
      expect(buttons).toHaveLength(2);
      expect(buttons.every((button) => button.disabled)).toBe(true);
      expect(officeButton?.getAttribute("aria-busy")).toBe("true");
      expect(container.querySelector('[role="alert"]')).toBeNull();

      await act(async () => {
        resolveSwitch();
        await pendingSwitch;
      });
      expect(officeButton?.disabled).toBe(false);
      expect(officeButton?.getAttribute("aria-busy")).toBe("false");
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it("shows an inline error and restores the inactive row after switching fails", async () => {
    mocks.switchPairedDesktop.mockRejectedValue(new Error("offline"));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(React.createElement(DevicesTab)));
      const officeButton = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Switch to Office Mac"]'
      );

      await act(async () => {
        officeButton?.click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mocks.switchPairedDesktop).toHaveBeenCalledWith("desktop-2");
      expect(officeButton?.disabled).toBe(false);
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        "Could not switch desktops"
      );
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
