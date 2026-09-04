import { describe, expect, it } from "vitest";

import {
  MOBILE_AUTH_STORAGE_KEY,
  readMobileAuthSession,
} from "./mobileAuthStorage";

describe("mobileAuthStorage", () => {
  it("reads the existing Org2Cloud auth schema without a parallel user field", () => {
    const stored = {
      kind: "org2_cloud",
      supabaseUrl: "https://example.supabase.co",
      supabaseAnonKey: "publishable",
      userId: "user-a",
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 1_800_000_000,
      profile: {
        displayName: "Mobile User",
        primaryEmail: "mobile@example.test",
        avatarUrl: "https://example.test/avatar.png",
      },
    };
    const storage = {
      getItem: (key: string) =>
        key === MOBILE_AUTH_STORAGE_KEY ? JSON.stringify(stored) : null,
    };
    expect(readMobileAuthSession(storage)).toEqual(stored);
    expect(readMobileAuthSession(storage)).not.toHaveProperty("user");
  });
});
