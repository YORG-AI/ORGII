import { afterEach, describe, expect, it, vi } from "vitest";

import { enrichOrg2CloudProfile } from "./completeSignIn";
import type {
  Org2CloudAuthState,
  Org2CloudRequestAuth,
} from "./org2CloudAuthAtom";

const { ensureFreshSessionMock, getCloudProfileMock } = vi.hoisted(() => ({
  ensureFreshSessionMock: vi.fn(),
  getCloudProfileMock: vi.fn(),
}));

vi.mock("@src/components/Message", () => ({
  default: { success: vi.fn() },
}));

vi.mock("@src/i18n", () => ({
  default: { t: (key: string) => key },
}));

vi.mock("./org2CloudClient", () => ({
  ensureFreshSession: ensureFreshSessionMock,
  getCloudProfile: getCloudProfileMock,
}));

const AUTH: Org2CloudAuthState = {
  kind: "org2_cloud",
  sessionId: "00000000-0000-4000-8000-000000000001",
  generation: 1,
  supabaseUrl: "https://old.example.test",
  userId: "user-1",
};

const LEASE: Org2CloudRequestAuth = {
  ...AUTH,
  supabaseAnonKey: "old-anon",
  accessToken: "access-old",
  expiresAt: 2_000_000_000,
};

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

afterEach(() => {
  vi.clearAllMocks();
});

describe("enrichOrg2CloudProfile", () => {
  it("binds profile enrichment to the endpoint captured by the session", async () => {
    const state = stateHarness(AUTH);
    ensureFreshSessionMock.mockResolvedValueOnce(LEASE);
    getCloudProfileMock.mockResolvedValueOnce({ displayName: "Vince" });

    await enrichOrg2CloudProfile(AUTH, state.setAuth);

    expect(getCloudProfileMock).toHaveBeenCalledWith("access-old", {
      supabaseUrl: "https://old.example.test",
      anonKey: "old-anon",
    });
    expect(state.current?.profile?.displayName).toBe("Vince");
  });

  it("does not fetch or merge after the user switches sessions mid-refresh", async () => {
    let resolveRefresh!: (value: Org2CloudRequestAuth) => void;
    ensureFreshSessionMock.mockImplementationOnce(
      () =>
        new Promise<Org2CloudRequestAuth>((resolve) => {
          resolveRefresh = resolve;
        })
    );
    const state = stateHarness(AUTH);
    const enrichment = enrichOrg2CloudProfile(AUTH, state.setAuth);
    const switched: Org2CloudAuthState = {
      ...AUTH,
      sessionId: "00000000-0000-4000-8000-000000000002",
      generation: 2,
      supabaseUrl: "https://new.example.test",
    };
    state.setAuth(switched);
    resolveRefresh(LEASE);

    await enrichment;

    expect(getCloudProfileMock).not.toHaveBeenCalled();
    expect(state.current).toBe(switched);
  });
});
