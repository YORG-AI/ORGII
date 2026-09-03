import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import SidebarOrgSelector from "../SidebarOrgSelector";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => (key === "common:status.loading" ? "Loading..." : key),
  }),
}));

vi.mock("@src/components/KeyboardShortcut/ToolbarTooltip", () => ({
  ToolbarTooltip: ({ children }: { children: React.ReactNode }) => children,
}));

const baseProps = {
  addOrgLabel: "Add org",
  cloudSignedIn: false,
  manageLabel: "Manage org",
  onChange: vi.fn(),
  onAddOrg: vi.fn(),
  onCloudSignIn: vi.fn(),
  onManageOrg: vi.fn(),
};

describe("SidebarOrgSelector", () => {
  it("shows Loading instead of Please select while the saved org resolves", () => {
    const markup = renderToStaticMarkup(
      React.createElement(SidebarOrgSelector, {
        ...baseProps,
        value: "cloud:org-1",
        options: [{ value: "personal", label: "Local profile" }],
        loading: true,
      })
    );

    expect(markup).toContain("Loading...");
    expect(markup).toContain('data-icon="loader-2"');
    expect(markup).not.toContain("placeholders.pleaseSelect");
  });

  it("shows the local profile when it is the resolved default", () => {
    const markup = renderToStaticMarkup(
      React.createElement(SidebarOrgSelector, {
        ...baseProps,
        value: "personal",
        options: [{ value: "personal", label: "Local profile" }],
        loading: false,
      })
    );

    expect(markup).toContain("Local profile");
    expect(markup).not.toContain("placeholders.pleaseSelect");
  });

  it("uses the sidebar-owned hover surface without the generic ghost treatment", () => {
    const markup = renderToStaticMarkup(
      React.createElement(SidebarOrgSelector, {
        ...baseProps,
        value: "personal",
        options: [{ value: "personal", label: "Local profile" }],
        loading: false,
      })
    );

    expect(markup).toContain("select-bare");
    expect(markup).not.toContain("select-ghost");
    expect(markup).toContain("hover:bg-sidebar-selected!");
  });

  it("does not repeat the signed-in identity in the organization menu", () => {
    const markup = renderToStaticMarkup(
      React.createElement(SidebarOrgSelector, {
        ...baseProps,
        value: "personal",
        options: [{ value: "personal", label: "Local profile" }],
        loading: false,
        cloudSignedIn: true,
      })
    );

    expect(markup).not.toContain("sidebar-cloud-signed-in");
    expect(markup).not.toContain("cloud.signedInAs");
    expect(markup).not.toContain("sidebar-cloud-sign-in");
  });
});
