// @vitest-environment jsdom
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsTab, resolvePermissionTierLabel } from "./SettingsTab";

const mocks = vi.hoisted(() => ({
  connection: {
    status: "connected" as const,
    presence: "online" as const,
    desktopName: "Home Mac",
    tier: "full" as const,
    demoMode: false,
  },
}));

vi.mock("../../app", () => ({
  useMobileRemote: () => ({ connection: mocks.connection }),
}));

const translations: Record<string, string> = {
  "settings.title": "Settings",
  "settings.connection": "Connection",
  "settings.desktop": "Desktop",
  "settings.relay": "Relay",
  "settings.permissionTier": "Permission tier",
  "settings.permissionFull": "Full access",
  "settings.permissionReadOnly": "Read only",
  "settings.mode": "Mode",
  "settings.modeLive": "Live",
  "settings.help": "Help",
  "settings.pairingGuide": "Pairing guide",
  "settings.revokePairing": "Revoke pairing",
  "settings.online": "Online",
  "settings.notAvailable": "—",
  "settings.unknownRelay": "Not connected",
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => translations[key] ?? key,
  }),
}));

describe("SettingsTab", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(
      "orgii-mobile-remote-config",
      JSON.stringify({ wsUrl: "wss://relay.example.test/v1/mobile/ws" })
    );
  });

  it("uses shared section rows and localizes protocol permission values", () => {
    const html = renderToStaticMarkup(React.createElement(SettingsTab));

    expect(html).toContain('data-testid="mobile-remote-connection-settings"');
    expect(html).toContain("section-layout-row");
    expect(html).toContain("flex-row justify-between gap-4");
    expect(html).toContain("flex min-w-0 items-center flex-1");
    expect(html).toContain("block w-full min-w-0 truncate text-right");
    expect(html).toContain("Home Mac · Online");
    expect(html).toContain("Full access");
    expect(html).not.toContain(">full<");
    expect(html).not.toContain("Revoke pairing");
  });

  it("only renders help actions when the owning behavior is supplied", () => {
    const html = renderToStaticMarkup(
      React.createElement(SettingsTab, {
        onOpenPairingGuide: vi.fn(),
        onRevokePairing: vi.fn(),
      })
    );

    expect(html).toContain('data-testid="mobile-remote-help-settings"');
    expect(html).toContain("Pairing guide");
    expect(html).toContain("Revoke pairing");
    expect(html.match(/<button/g)).toHaveLength(2);
  });

  it("maps both wire permission tiers to presentation copy", () => {
    const t = (key: string) => translations[key] ?? key;
    expect(resolvePermissionTierLabel("full", t)).toBe("Full access");
    expect(resolvePermissionTierLabel("read_only", t)).toBe("Read only");
  });
});
