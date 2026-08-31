import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import SidebarAccountButton from "../SidebarAccountButton";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { name?: string }) =>
      options?.name ? `${key}:${options.name}` : key,
  }),
}));

describe("SidebarAccountButton", () => {
  it("shows the signed-in avatar and identity with text-1 styling", () => {
    const markup = renderToStaticMarkup(
      React.createElement(SidebarAccountButton, {
        identity: "Ada Lovelace",
        avatarUrl: "https://example.com/ada.png",
        menuOpen: true,
        onClick: vi.fn(),
      })
    );

    expect(markup).toContain('data-testid="sidebar-account-profile"');
    expect(markup).toContain('src="https://example.com/ada.png"');
    expect(markup).toContain("Ada Lovelace");
    expect(markup).toContain("text-text-1");
    expect(markup).toContain("gap-3");
    expect(markup).toContain("h-[14px] w-[14px]");
    expect(markup).toContain("width:20px");
    expect(markup).toContain(
      'class="min-w-0 flex-1 truncate text-[13px] leading-4 text-text-1"'
    );
    expect(markup).toContain('aria-expanded="true"');
  });

  it("shows the sign-in action without an identity", () => {
    const markup = renderToStaticMarkup(
      React.createElement(SidebarAccountButton, {
        identity: null,
        menuOpen: false,
        onClick: vi.fn(),
      })
    );

    expect(markup).toContain('data-testid="sidebar-account-sign-in"');
    expect(markup).toContain("cloud.signIn");
    expect(markup).toContain('width="14"');
    expect(markup).toContain("gap-3");
    expect(markup).not.toContain("sidebar-account-profile");
  });
});
