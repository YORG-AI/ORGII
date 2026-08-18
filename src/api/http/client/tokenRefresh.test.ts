import { beforeEach, describe, expect, it, vi } from "vitest";

import { getOrRefreshHostedToken } from "./tokenRefresh";

const mocks = vi.hoisted(() => ({
  getLease: vi.fn(),
  getSnapshot: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@src/features/Identity/identityClient", () => ({
  getIdentityErrorCode: (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error
      ? (error as { code: string }).code
      : null,
  identityClient: { getHostedServiceAccessLease: mocks.getLease },
}));
vi.mock("@src/features/Identity/identitySnapshotAtom", () => ({
  readIdentitySnapshot: mocks.getSnapshot,
}));
vi.mock("@src/hooks/logger", () => ({
  createLogger: () => ({ warn: mocks.warn }),
}));

const session = {
  sessionId: "550e8400-e29b-41d4-a716-446655440000",
  realm: "hosted_service_legacy" as const,
  issuer: "https://project.supabase.co",
  subject: "hosted-user",
  scopes: [],
  status: "offline_degraded" as const,
  generation: 4,
};

function snapshot(
  status: "offline_degraded" | "reauth_required" = session.status
) {
  return {
    revision: 5,
    sessions: [{ ...session, status }],
    activeSessions: { hosted_service_legacy: session.sessionId },
    flows: [],
    secureStoreStatus: "available" as const,
  };
}

describe("Hosted native access leases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSnapshot.mockReturnValue(snapshot());
  });

  it("returns a native lease without a renderer credential owner", async () => {
    mocks.getLease.mockResolvedValue({ accessToken: "short-lived-access" });

    await expect(getOrRefreshHostedToken()).resolves.toBe("short-lived-access");
    expect(mocks.getLease).toHaveBeenCalledWith({
      sessionId: session.sessionId,
      generation: session.generation,
    });
  });

  it("does not ask the Broker to refresh a reauth-required session", async () => {
    mocks.getSnapshot.mockReturnValue(snapshot("reauth_required"));

    await expect(getOrRefreshHostedToken()).resolves.toBeNull();
    expect(mocks.getLease).not.toHaveBeenCalled();
  });

  it("keeps another realm isolated when Hosted refresh is rejected", async () => {
    mocks.getLease.mockRejectedValue({
      code: "identity_access_refresh_rejected",
    });

    await expect(getOrRefreshHostedToken()).resolves.toBeNull();
    expect(mocks.warn).not.toHaveBeenCalled();
  });
});
