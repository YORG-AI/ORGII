import { describe, expect, it } from "vitest";

import {
  type MobileAuthSession,
  createInitialMobileAuthState,
  reduceMobileAuthState,
} from "./mobileAuthState";

const session: MobileAuthSession = {
  kind: "org2_cloud",
  supabaseUrl: "https://example.supabase.co",
  supabaseAnonKey: "publishable",
  userId: "user-a",
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: 1234,
  profile: { primaryEmail: "mobile@example.test" },
};

describe("mobileAuthState", () => {
  it("models the complete signed-out to signed-in lifecycle", () => {
    const checking = createInitialMobileAuthState();
    const signedOut = reduceMobileAuthState(checking, {
      type: "signed_out",
      generation: 1,
    });
    const redirecting = reduceMobileAuthState(signedOut, {
      type: "begin",
      phase: "redirecting",
      generation: 2,
    });
    const exchanging = reduceMobileAuthState(redirecting, {
      type: "begin",
      phase: "exchanging",
      generation: 3,
    });
    const signedIn = reduceMobileAuthState(exchanging, {
      type: "signed_in",
      generation: 3,
      session,
      recoveredPairingIntent: "https://relay/#pair=opaque",
    });

    expect(signedOut.phase).toBe("signed_out");
    expect(redirecting.phase).toBe("redirecting");
    expect(exchanging.phase).toBe("exchanging");
    expect(signedIn).toMatchObject({
      phase: "signed_in",
      session,
      recoveredPairingIntent: "https://relay/#pair=opaque",
    });
  });

  it("ignores stale async completions after logout or a newer attempt", () => {
    const signedOut = reduceMobileAuthState(
      { phase: "checking", generation: 4 },
      { type: "signed_out", generation: 5 }
    );
    expect(
      reduceMobileAuthState(signedOut, {
        type: "signed_in",
        generation: 4,
        session,
        recoveredPairingIntent: null,
      })
    ).toEqual(signedOut);
  });
});
