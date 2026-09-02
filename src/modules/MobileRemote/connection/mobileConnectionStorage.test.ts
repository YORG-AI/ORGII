import { describe, expect, it } from "vitest";

import {
  listScopedMobilePairedDesktops,
  loadScopedMobileConnectionConfig,
  mobileConnectionStorageKey,
  saveScopedMobileConnectionConfig,
  selectScopedMobilePairedDesktop,
} from "./mobileConnectionStorage";

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}

describe("mobileConnectionStorage", () => {
  it("isolates retained pairing config by authenticated user id", () => {
    const storage = new MemoryStorage();
    saveScopedMobileConnectionConfig(
      "user-a",
      { wsUrl: "wss://a.example/v1/mobile/ws" },
      storage
    );
    saveScopedMobileConnectionConfig(
      "user-b",
      { wsUrl: "wss://b.example/v1/mobile/ws" },
      storage
    );
    expect(loadScopedMobileConnectionConfig("user-a", storage)).toEqual({
      wsUrl: "wss://a.example/v1/mobile/ws",
    });
    expect(loadScopedMobileConnectionConfig("user-b", storage)).toEqual({
      wsUrl: "wss://b.example/v1/mobile/ws",
    });
  });

  it("never falls back to the legacy global config", () => {
    const storage = new MemoryStorage();
    storage.setItem(
      "orgii-mobile-remote-config",
      JSON.stringify({ wsUrl: "wss://legacy.example/v1/mobile/ws" })
    );
    expect(loadScopedMobileConnectionConfig("user-a", storage)).toBeNull();
    expect(mobileConnectionStorageKey("user-a")).not.toBe(
      "orgii-mobile-remote-config"
    );
  });

  it("retains bounded account-scoped inventory when active selection clears", () => {
    const storage = new MemoryStorage();
    saveScopedMobileConnectionConfig(
      "user-a",
      {
        wsUrl: "wss://a.example/v1/mobile/ws",
        desktopId: "desktop-a",
        deviceLabel: "Home Mac",
      },
      storage,
      1
    );
    saveScopedMobileConnectionConfig(
      "user-a",
      {
        wsUrl: "wss://b.example/v1/mobile/ws",
        desktopId: "desktop-b",
        deviceLabel: "Office Mac",
      },
      storage,
      2
    );
    saveScopedMobileConnectionConfig("user-a", null, storage, 3);

    expect(loadScopedMobileConnectionConfig("user-a", storage)).toBeNull();
    expect(listScopedMobilePairedDesktops("user-a", storage)).toEqual([
      { id: "desktop-b", name: "Office Mac", active: false, updatedAtMs: 2 },
      { id: "desktop-a", name: "Home Mac", active: false, updatedAtMs: 1 },
    ]);
    expect(listScopedMobilePairedDesktops("user-b", storage)).toEqual([]);
  });

  it("selects an existing desktop without copying credentials into summaries", () => {
    const storage = new MemoryStorage();
    saveScopedMobileConnectionConfig(
      "user-a",
      {
        wsUrl: "wss://a.example/v1/mobile/ws",
        desktopId: "desktop-a",
        deviceLabel: "Home Mac",
        deviceToken: "secret-a",
      },
      storage,
      1
    );
    saveScopedMobileConnectionConfig(
      "user-a",
      {
        wsUrl: "wss://b.example/v1/mobile/ws",
        desktopId: "desktop-b",
        deviceLabel: "Office Mac",
        deviceToken: "secret-b",
      },
      storage,
      2
    );

    expect(
      selectScopedMobilePairedDesktop("user-a", "desktop-a", storage)
    ).toMatchObject({ desktopId: "desktop-a", deviceToken: "secret-a" });
    expect(loadScopedMobileConnectionConfig("user-a", storage)).toMatchObject({
      desktopId: "desktop-a",
    });
    expect(listScopedMobilePairedDesktops("user-a", storage)).toEqual([
      { id: "desktop-b", name: "Office Mac", active: false, updatedAtMs: 2 },
      { id: "desktop-a", name: "Home Mac", active: true, updatedAtMs: 1 },
    ]);
    expect(
      JSON.stringify(listScopedMobilePairedDesktops("user-a", storage))
    ).not.toContain("secret-a");
  });
});
