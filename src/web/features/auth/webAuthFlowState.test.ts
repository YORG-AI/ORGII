import { describe, expect, it } from "vitest";

import {
  WEB_AUTH_STATE_STORAGE_KEY,
  consumeWebAuthCallbackState,
  createWebAuthCallbackUrl,
  validateWebAuthCallbackState,
} from "./webAuthFlowState";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

describe("web auth callback state", () => {
  it("creates a high-entropy callback correlation stored for this tab", () => {
    const storage = memoryStorage();
    const callbackUrl = createWebAuthCallbackUrl({
      origin: "https://app.example.com",
      storage,
      fillRandom: (buffer) => {
        buffer.fill(0xab);
        return buffer;
      },
    });
    const state = "ab".repeat(32);

    expect(callbackUrl).toBe(
      `https://app.example.com/auth/callback?state=${state}`
    );
    expect(storage.getItem(WEB_AUTH_STATE_STORAGE_KEY)).toBe(state);
  });

  it("rejects missing, duplicate, or mismatched callback state", () => {
    const storage = memoryStorage();
    storage.setItem(WEB_AUTH_STATE_STORAGE_KEY, "expected");

    for (const href of [
      "https://app.example.com/auth/callback",
      "https://app.example.com/auth/callback?state=other",
      "https://app.example.com/auth/callback?state=expected&state=expected",
    ]) {
      expect(
        validateWebAuthCallbackState(href, {
          origin: "https://app.example.com",
          storage,
        })
      ).toBeNull();
    }
    expect(storage.getItem(WEB_AUTH_STATE_STORAGE_KEY)).toBe("expected");
  });

  it("accepts the matching callback and consumes it exactly once", () => {
    const storage = memoryStorage();
    storage.setItem(WEB_AUTH_STATE_STORAGE_KEY, "expected");

    expect(
      validateWebAuthCallbackState(
        "https://app.example.com/auth/callback?state=expected#access_token=x",
        { origin: "https://app.example.com", storage }
      )
    ).toEqual({
      expectedCallbackUrl:
        "https://app.example.com/auth/callback?state=expected",
      state: "expected",
    });
    expect(consumeWebAuthCallbackState("expected", storage)).toBe(true);
    expect(consumeWebAuthCallbackState("expected", storage)).toBe(false);
  });
});
