import { describe, expect, it, vi } from "vitest";

import { initializeIdentityLifecycle } from "./identityLifecycle";

const mocks = vi.hoisted(() => ({
  getSnapshot: vi.fn(),
  retryRestore: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));
vi.mock("@src/api/http/auth/sharedAuthStorage", () => ({
  SHARED_AUTH_PERSISTED_EVENT: "orgii:test-auth-persisted",
  deleteLegacyOrg2CloudAuthEnvelope: vi.fn(),
  flushSharedServiceAuthStorage: vi.fn(async () => undefined),
}));
vi.mock("./identityClient", () => ({
  identityClient: {
    getSnapshot: mocks.getSnapshot,
    importLegacyCloudIdentity: vi.fn(async () => null),
    retryRestore: mocks.retryRestore,
    signOut: vi.fn(),
  },
}));

const SNAPSHOT = {
  revision: 4,
  sessions: [
    {
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
      realm: "hosted_service_legacy" as const,
      issuer: "https://project.supabase.co",
      subject: "hosted-user",
      displayName: null,
      primaryEmail: null,
      avatarUrl: null,
      scopes: [],
      expiresAtUnix: 2_000_000_000,
      status: "offline_degraded" as const,
      generation: 2,
    },
  ],
  activeSessions: {
    hosted_service_legacy: "550e8400-e29b-41d4-a716-446655440000",
  },
  flows: [],
  secureStoreStatus: "available" as const,
};

describe("identity focus restore", () => {
  it("does not reread Keychain credentials for an already restored session", async () => {
    const addEventListener = vi.spyOn(window, "addEventListener");
    mocks.retryRestore.mockResolvedValue(SNAPSHOT);
    mocks.getSnapshot.mockResolvedValue({ ...SNAPSHOT, revision: 5 });
    await initializeIdentityLifecycle();
    expect(mocks.retryRestore).toHaveBeenCalledTimes(1);

    const focusListener = addEventListener.mock.calls.find(
      ([eventName]) => eventName === "focus"
    )?.[1] as EventListener | undefined;
    expect(focusListener).toBeDefined();
    focusListener?.(new Event("focus"));
    await vi.waitFor(() => expect(mocks.getSnapshot).toHaveBeenCalledTimes(1));
    expect(mocks.retryRestore).toHaveBeenCalledTimes(1);
  });
});
