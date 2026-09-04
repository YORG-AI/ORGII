import { describe, expect, it } from "vitest";

import {
  loadScopedMobileConnectionConfig,
  mobileConnectionStorageKey,
  saveScopedMobileConnectionConfig,
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
});
