import { describe, expect, it } from "vitest";

import type {
  CookieImportPreview,
  CookieSiteGroup,
} from "@src/api/tauri/browserCookies";

import {
  initialSelectedDomains,
  selectAllState,
  selectedCookieCount,
  setAllDomains,
  toggleDomain,
} from "./importCookiesSelection";

function site(overrides: Partial<CookieSiteGroup>): CookieSiteGroup {
  return {
    domain: "example.com",
    cookieCount: 1,
    category: "general",
    defaultSelected: true,
    sampleHosts: ["example.com"],
    ...overrides,
  };
}

const preview: CookieImportPreview = {
  sourceId: "chromium:chrome:Default",
  totalCookies: 30,
  warning: null,
  sites: [
    site({ domain: "github.com", cookieCount: 12, defaultSelected: true }),
    site({
      domain: "chase.com",
      cookieCount: 8,
      category: "banking",
      defaultSelected: false,
    }),
    site({ domain: "news.com", cookieCount: 10, defaultSelected: true }),
  ],
};

describe("initialSelectedDomains", () => {
  it("checks only the default-selected sites (money/mail/SSO excluded)", () => {
    const selected = initialSelectedDomains(preview);
    expect([...selected].sort()).toEqual(["github.com", "news.com"]);
    expect(selected.has("chase.com")).toBe(false);
  });
});

describe("toggleDomain", () => {
  it("adds and removes without mutating the input set", () => {
    const start = new Set(["github.com"]);
    const added = toggleDomain(start, "chase.com");
    expect(start.has("chase.com")).toBe(false);
    expect(added.has("chase.com")).toBe(true);
    expect(toggleDomain(added, "chase.com").has("chase.com")).toBe(false);
  });
});

describe("setAllDomains", () => {
  it("selects every site or clears the selection", () => {
    expect(setAllDomains(preview.sites, true).size).toBe(3);
    expect(setAllDomains(preview.sites, false).size).toBe(0);
  });
});

describe("selectedCookieCount", () => {
  it("sums cookie counts across selected sites only", () => {
    const selected = new Set(["github.com", "news.com"]);
    expect(selectedCookieCount(preview.sites, selected)).toBe(22);
  });
});

describe("selectAllState", () => {
  it("reports all / none / some", () => {
    expect(selectAllState(preview.sites, new Set())).toBe("none");
    expect(
      selectAllState(
        preview.sites,
        new Set(["github.com", "chase.com", "news.com"])
      )
    ).toBe("all");
    expect(selectAllState(preview.sites, new Set(["github.com"]))).toBe("some");
  });
});
