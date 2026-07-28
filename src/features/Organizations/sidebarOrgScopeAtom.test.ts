import { createStore } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";

const STORAGE_KEY = "orgii:sidebar-selected-org-id:v1";

describe("sidebarSelectedOrgIdAtom", () => {
  afterEach(() => {
    localStorage.removeItem(STORAGE_KEY);
    vi.resetModules();
  });

  it("restores the selected organization synchronously on startup", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify("cloud:org-2"));
    vi.resetModules();

    const { sidebarSelectedOrgIdAtom } = await import("./sidebarOrgScopeAtom");
    const store = createStore();

    expect(store.get(sidebarSelectedOrgIdAtom)).toBe("cloud:org-2");
  });

  it("writes selection changes through to localStorage", async () => {
    vi.resetModules();
    const { sidebarSelectedOrgIdAtom } = await import("./sidebarOrgScopeAtom");
    const store = createStore();

    store.set(sidebarSelectedOrgIdAtom, "local-org-1");

    expect(localStorage.getItem(STORAGE_KEY)).toBe(
      JSON.stringify("local-org-1")
    );
  });
});
