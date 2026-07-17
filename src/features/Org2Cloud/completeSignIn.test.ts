import { afterEach, describe, expect, it, vi } from "vitest";

import { enrichOrg2CloudProfile } from "./completeSignIn";
import type { Org2CloudAuthState } from "./org2CloudAuthAtom";

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
  supabaseUrl: "https://old.example.test",
  supabaseAnonKey: "old-anon",
  userId: "user-1",
  accessToken: "access-old",
  refreshToken: "refresh-old",
  expiresAt: 1,
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
    ensureFreshSessionMock.mockResolvedValueOnce(AUTH);
    getCloudProfileMock.mockResolvedValueOnce({ displayName: "Vince" });

    await enrichOrg2CloudProfile(AUTH, state.setAuth);

    expect(getCloudProfileMock).toHaveBeenCalledWith("access-old", {
      supabaseUrl: "https://old.example.test",
      anonKey: "old-anon",
    });
    expect(state.current?.profile?.displayName).toBe("Vince");
  });

  it("does not fetch or merge after the user switches sessions mid-refresh", async () => {
    let resolveRefresh!: (value: Org2CloudAuthState) => void;
    ensureFreshSessionMock.mockImplementationOnce(
      () =>
        new Promise<Org2CloudAuthState>((resolve) => {
          resolveRefresh = resolve;
        })
    );
    const state = stateHarness(AUTH);
    const enrichment = enrichOrg2CloudProfile(AUTH, state.setAuth);
    const switched: Org2CloudAuthState = {
      ...AUTH,
      supabaseUrl: "https://new.example.test",
      supabaseAnonKey: "new-anon",
      accessToken: "access-new",
    };
    state.setAuth(switched);
    resolveRefresh(AUTH);

    await enrichment;

    expect(getCloudProfileMock).not.toHaveBeenCalled();
    expect(state.current).toBe(switched);
  });
});
