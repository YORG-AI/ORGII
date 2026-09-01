import { describe, expect, it, vi } from "vitest";

import {
  beginMobileOAuthAttempt,
  captureOpaquePairingIntent,
  consumeMobileOAuthAttempt,
  consumeOpaquePairingIntent,
} from "./mobileAuthIntent";

class MemoryStorage {
  private values = new Map<string, string>();
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

describe("mobileAuthIntent", () => {
  it("captures pairing credentials opaquely and scrubs the URL synchronously", () => {
    const storage = new MemoryStorage();
    const replaceState = vi.fn();
    const raw =
      "https://mobile.example/orgii/mobile#pair=secret-base64-payload";

    expect(
      captureOpaquePairingIntent(
        {
          href: raw,
          hash: "#pair=secret-base64-payload",
          pathname: "/orgii/mobile",
          search: "",
        } as Location,
        { replaceState, state: null } as unknown as History,
        storage as unknown as Storage,
        1_000
      )
    ).toBe(raw);
    expect(replaceState).toHaveBeenCalledWith(null, "", "/orgii/mobile");
    expect(
      consumeOpaquePairingIntent(storage as unknown as Storage, 1_001)
    ).toBe(raw);
    expect(
      consumeOpaquePairingIntent(storage as unknown as Storage, 1_002)
    ).toBeNull();
  });

  it("uses a single-use, expiring OAuth attempt marker without callback state", () => {
    const storage = new MemoryStorage();
    beginMobileOAuthAttempt("attempt-a", storage as unknown as Storage, 1_000);
    expect(
      consumeMobileOAuthAttempt(storage as unknown as Storage, 1_001)
    ).toBe(true);
    expect(
      consumeMobileOAuthAttempt(storage as unknown as Storage, 1_002)
    ).toBe(false);

    beginMobileOAuthAttempt("attempt-b", storage as unknown as Storage, 1_000);
    expect(
      consumeMobileOAuthAttempt(
        storage as unknown as Storage,
        1_000 + 11 * 60 * 1_000
      )
    ).toBe(false);
  });
});
