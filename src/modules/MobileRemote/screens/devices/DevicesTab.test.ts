import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { DevicesTab, derivePairedDesktopsFromConnection } from "./DevicesTab";

vi.mock("../../app", () => ({
  useMobileRemote: () => ({
    connection: {
      desktopId: "desktop-1",
      desktopName: "Home Mac",
      presence: "online",
    },
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
  "devices.emptyDesktops": "No paired desktops",
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => translations[key] ?? key,
  }),
}));

describe("DevicesTab", () => {
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

  it("does not invent a paired device without an authoritative desktop name", () => {
    expect(derivePairedDesktopsFromConnection({ presence: "unknown" })).toEqual(
      []
    );
  });
});
