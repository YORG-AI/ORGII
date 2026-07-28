import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ORG2_CLOUD_ENDPOINT_OVERRIDE_STORAGE_KEY,
  ORG2_CLOUD_OFFICIAL_WEB_ORIGIN,
  buildCloudBillingLoginUrl,
} from "./config";
import type { Org2CloudAuthState } from "./org2CloudAuthAtom";
import { openCloudBilling } from "./useOpenCloudBilling";

const { ensureFreshSessionMock, messageErrorMock, openUrlMock } = vi.hoisted(
  () => ({
    ensureFreshSessionMock: vi.fn(),
    messageErrorMock: vi.fn(),
    openUrlMock: vi.fn(),
  })
);

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: openUrlMock,
}));

vi.mock("@src/components/Message", () => ({
  default: { error: messageErrorMock },
}));

vi.mock("@src/i18n", () => ({
  default: { t: (key: string) => key },
}));

vi.mock("./org2CloudClient", () => ({
  ensureFreshSession: ensureFreshSessionMock,
}));

const AUTH: Org2CloudAuthState = {
  kind: "org2_cloud",
  supabaseUrl: "https://project.supabase.test",
  supabaseAnonKey: "anon-key",
  userId: "user-1",
  accessToken: "access-1",
  refreshToken: "refresh-1",
  expiresAt: 9_999_999_999,
};

const BRIDGE_URL = `${ORG2_CLOUD_OFFICIAL_WEB_ORIGIN}/api/auth/bridge`;
const VERIFY_URL = `${ORG2_CLOUD_OFFICIAL_WEB_ORIGIN}/auth/callback?token_hash=abc&type=magiclink&return_to=%2Fbilling`;

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stateHarness(initial: Org2CloudAuthState | null) {
  let current = initial;
  return {
    get current() {
      return current;
    },
    setAuth(
      update:
        | Org2CloudAuthState
        | null
        | ((prev: Org2CloudAuthState | null) => Org2CloudAuthState | null)
    ) {
      current = typeof update === "function" ? update(current) : update;
    },
  };
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  localStorage.removeItem(ORG2_CLOUD_ENDPOINT_OVERRIDE_STORAGE_KEY);
});

describe("openCloudBilling", () => {
  it("opens the bridge verifyUrl when the bridge succeeds", async () => {
    const state = stateHarness(AUTH);
    ensureFreshSessionMock.mockResolvedValueOnce(AUTH);
    fetchMock.mockResolvedValueOnce(jsonResponse({ verifyUrl: VERIFY_URL }));

    await openCloudBilling(AUTH, state.setAuth);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(BRIDGE_URL);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer access-1");
    expect(headers["content-type"]).toBe("application/json");
    expect(JSON.parse(String(init.body))).toEqual({ return_to: "/billing" });
    expect(openUrlMock).toHaveBeenCalledWith(VERIFY_URL);
    expect(messageErrorMock).not.toHaveBeenCalled();
  });

  it("commits a rotated session and uses its access token", async () => {
    const state = stateHarness(AUTH);
    const fresh: Org2CloudAuthState = {
      ...AUTH,
      accessToken: "access-2",
      refreshToken: "refresh-2",
    };
    ensureFreshSessionMock.mockResolvedValueOnce(fresh);
    fetchMock.mockResolvedValueOnce(jsonResponse({ verifyUrl: VERIFY_URL }));

    await openCloudBilling(AUTH, state.setAuth);

    expect(state.current).toBe(fresh);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer access-2");
    expect(openUrlMock).toHaveBeenCalledWith(VERIFY_URL);
  });

  it("opens the web login when signed out, without calling the bridge", async () => {
    const state = stateHarness(null);

    await openCloudBilling(null, state.setAuth);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(openUrlMock).toHaveBeenCalledWith(buildCloudBillingLoginUrl());
    expect(messageErrorMock).not.toHaveBeenCalled();
  });

  it("falls back to the web login when the token refresh fails", async () => {
    const state = stateHarness(AUTH);
    ensureFreshSessionMock.mockResolvedValueOnce(null);

    await openCloudBilling(AUTH, state.setAuth);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(openUrlMock).toHaveBeenCalledWith(buildCloudBillingLoginUrl());
    expect(messageErrorMock).not.toHaveBeenCalled();
  });

  it("falls back to the web login on a non-200 bridge response", async () => {
    const state = stateHarness(AUTH);
    ensureFreshSessionMock.mockResolvedValueOnce(AUTH);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ error: "unauthorized" }, 401)
    );

    await openCloudBilling(AUTH, state.setAuth);

    expect(openUrlMock).toHaveBeenCalledWith(buildCloudBillingLoginUrl());
    expect(messageErrorMock).not.toHaveBeenCalled();
  });

  it("falls back to the web login on a network error", async () => {
    const state = stateHarness(AUTH);
    ensureFreshSessionMock.mockResolvedValueOnce(AUTH);
    fetchMock.mockRejectedValueOnce(new Error("offline"));

    await openCloudBilling(AUTH, state.setAuth);

    expect(openUrlMock).toHaveBeenCalledWith(buildCloudBillingLoginUrl());
    expect(messageErrorMock).not.toHaveBeenCalled();
  });

  it("refuses a foreign-origin verifyUrl and falls back to the web login", async () => {
    const state = stateHarness(AUTH);
    ensureFreshSessionMock.mockResolvedValueOnce(AUTH);
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        verifyUrl: "https://evil.example.com/auth/callback?token_hash=abc",
      })
    );

    await openCloudBilling(AUTH, state.setAuth);

    expect(openUrlMock).toHaveBeenCalledWith(buildCloudBillingLoginUrl());
    expect(messageErrorMock).not.toHaveBeenCalled();
  });

  it("falls back to the web login on an unexpected response shape", async () => {
    const state = stateHarness(AUTH);
    ensureFreshSessionMock.mockResolvedValueOnce(AUTH);
    fetchMock.mockResolvedValueOnce(jsonResponse({ url: VERIFY_URL }));

    await openCloudBilling(AUTH, state.setAuth);

    expect(openUrlMock).toHaveBeenCalledWith(buildCloudBillingLoginUrl());
  });

  it("falls back to the web login when verifyUrl is not a URL", async () => {
    const state = stateHarness(AUTH);
    ensureFreshSessionMock.mockResolvedValueOnce(AUTH);
    fetchMock.mockResolvedValueOnce(jsonResponse({ verifyUrl: "not a url" }));

    await openCloudBilling(AUTH, state.setAuth);

    expect(openUrlMock).toHaveBeenCalledWith(buildCloudBillingLoginUrl());
  });

  it("targets a custom endpoint's web origin for bridge and origin check", async () => {
    localStorage.setItem(
      ORG2_CLOUD_ENDPOINT_OVERRIDE_STORAGE_KEY,
      JSON.stringify({
        webOrigin: "https://cloud.acme.dev",
        supabaseUrl: "https://supabase.acme.dev",
        anonKey: "sb_publishable_custom",
      })
    );
    const state = stateHarness(AUTH);
    ensureFreshSessionMock.mockResolvedValueOnce(AUTH);
    const customVerifyUrl =
      "https://cloud.acme.dev/auth/callback?token_hash=abc&type=magiclink";
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ verifyUrl: customVerifyUrl })
    );

    await openCloudBilling(AUTH, state.setAuth);

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("https://cloud.acme.dev/api/auth/bridge");
    expect(openUrlMock).toHaveBeenCalledWith(customVerifyUrl);
  });

  it("toasts only when the browser open itself fails", async () => {
    const state = stateHarness(AUTH);
    ensureFreshSessionMock.mockResolvedValueOnce(AUTH);
    fetchMock.mockResolvedValueOnce(jsonResponse({ verifyUrl: VERIFY_URL }));
    openUrlMock.mockRejectedValueOnce(new Error("no browser"));

    await openCloudBilling(AUTH, state.setAuth);

    expect(messageErrorMock).toHaveBeenCalledWith(
      "navigation:cloud.billing.openFailed"
    );
  });
});
