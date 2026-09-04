import { describe, expect, it, vi } from "vitest";

import { MobileAuthClientError } from "../../auth/mobileAuthClient";
import {
  TAURI_MOBILE_OAUTH_STORAGE_PREFIX,
  createTauriMobileAuthClient,
  createTauriOAuthStorage,
  toTauriMobileAuthError,
} from "./tauriMobileAuthClient";
import type { TauriMobileRemoteBridge } from "./types";

// The real `createClient` builds a RealtimeClient, which throws on a Node
// runtime without a global WebSocket (CI runs Node 20). The adapter under test
// only owns storage/error/server-session policy, so stub the SDK the same way
// `auth/mobileAuthClient.test.ts` does.
const mocks = vi.hoisted(() => ({ createClient: vi.fn(() => ({ auth: {} })) }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: mocks.createClient,
}));

function createBridge(): TauriMobileRemoteBridge {
  return {
    openExternal: vi.fn().mockResolvedValue(undefined),
    secureRead: vi.fn().mockResolvedValue(null),
    secureWrite: vi.fn().mockResolvedValue(undefined),
    secureDelete: vi.fn().mockResolvedValue(undefined),
    getInitialDeepLinks: vi.fn().mockResolvedValue([]),
    subscribeDeepLinks: vi.fn().mockResolvedValue(() => undefined),
  };
}

describe("Tauri mobile auth adapter", () => {
  it("persists Supabase PKCE verifier state through the Keychain bridge", async () => {
    const bridge = createBridge();
    vi.mocked(bridge.secureRead).mockResolvedValue("pkce-value");
    const storage = createTauriOAuthStorage(bridge);

    await expect(storage.getItem("auth-token-code-verifier")).resolves.toBe(
      "pkce-value"
    );
    await storage.setItem("auth-token-code-verifier", "next-value");
    await storage.removeItem("auth-token-code-verifier");

    const key = `${TAURI_MOBILE_OAUTH_STORAGE_PREFIX}auth-token-code-verifier`;
    expect(bridge.secureRead).toHaveBeenCalledWith(key);
    expect(bridge.secureWrite).toHaveBeenCalledWith(key, "next-value");
    expect(bridge.secureDelete).toHaveBeenCalledWith(key);
  });

  it.each([
    ["unauthorized", false],
    ["invalid_callback", false],
    ["network", true],
    ["keychain_locked", true],
  ] as const)("maps native %s errors to retry policy", (code, retryable) => {
    expect(toTauriMobileAuthError({ code, message: `native ${code}` })).toEqual(
      expect.objectContaining<Partial<MobileAuthClientError>>({
        message: `native ${code}`,
        retryable,
      })
    );
  });

  it("does not attempt the browser-only server-cookie exchange", async () => {
    const bridge = createBridge();
    const fetcher = vi.fn<typeof fetch>();
    const client = createTauriMobileAuthClient({ bridge, fetcher });

    await expect(client.establishServerSession("access")).resolves.toBe(
      undefined
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});
