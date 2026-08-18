import { beforeEach, describe, expect, it, vi } from "vitest";

import { signOutIdentity } from "./identityLifecycle";
import { createEmptyIdentitySnapshot } from "./identityTypes";

const mocks = vi.hoisted(() => ({
  deleteLegacyOrg2CloudAuthEnvelope: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@src/api/http/auth/sharedAuthStorage", () => ({
  SHARED_AUTH_PERSISTED_EVENT: "orgii:test-auth-persisted",
  deleteLegacyOrg2CloudAuthEnvelope: mocks.deleteLegacyOrg2CloudAuthEnvelope,
  flushSharedServiceAuthStorage: vi.fn(async () => undefined),
}));
vi.mock("./identityClient", () => ({
  identityClient: {
    getSnapshot: vi.fn(),
    importLegacyCloudIdentity: vi.fn(),
    retryRestore: vi.fn(),
    signOut: mocks.signOut,
  },
}));

describe("signOutIdentity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteLegacyOrg2CloudAuthEnvelope.mockResolvedValue(undefined);
    mocks.signOut.mockResolvedValue({
      ...createEmptyIdentitySnapshot(),
      revision: 7,
    });
  });

  it("deletes the Cloud rollback envelope before the Broker signs out", async () => {
    await signOutIdentity("org2_cloud", {
      sessionId: "00000000-0000-4000-8000-000000000001",
    });

    expect(mocks.deleteLegacyOrg2CloudAuthEnvelope).toHaveBeenCalledTimes(1);
    expect(mocks.signOut).toHaveBeenCalledWith(
      "org2_cloud",
      "00000000-0000-4000-8000-000000000001"
    );
    expect(
      mocks.deleteLegacyOrg2CloudAuthEnvelope.mock.invocationCallOrder[0]
    ).toBeLessThan(mocks.signOut.mock.invocationCallOrder[0]);
  });

  it("does not create a resurrection window when legacy deletion fails", async () => {
    mocks.deleteLegacyOrg2CloudAuthEnvelope.mockRejectedValue(
      new Error("shared store unavailable")
    );

    await expect(signOutIdentity("org2_cloud")).rejects.toThrow(
      "shared store unavailable"
    );
    expect(mocks.signOut).not.toHaveBeenCalled();
  });

  it("signs out Hosted without touching the Cloud rollback envelope", async () => {
    await signOutIdentity("hosted_service_legacy");

    expect(mocks.deleteLegacyOrg2CloudAuthEnvelope).not.toHaveBeenCalled();
    expect(mocks.signOut).toHaveBeenCalledWith(
      "hosted_service_legacy",
      undefined
    );
  });
});
