import { beforeEach, describe, expect, it, vi } from "vitest";

import { importBundledOrg2CloudAuthForDev } from "./devBundledAuthImport";

const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tauri-apps/api/core")>()),
  invoke,
}));

const VALID_AUTH = {
  kind: "org2_cloud",
  supabaseUrl: "https://example.supabase.co",
  supabaseAnonKey: "anon",
  userId: "user-1",
  accessToken: "access",
  refreshToken: "refresh",
  expiresAt: 2_000_000_000,
};

describe("importBundledOrg2CloudAuthForDev", () => {
  beforeEach(() => invoke.mockReset());

  it("parses the allow-listed bundled auth payload", async () => {
    invoke.mockResolvedValue(JSON.stringify(VALID_AUTH));

    await expect(importBundledOrg2CloudAuthForDev()).resolves.toEqual(
      VALID_AUTH
    );
    expect(invoke).toHaveBeenCalledWith("debug_import_bundled_org2_cloud_auth");
  });

  it("returns null when the bundled app is signed out", async () => {
    invoke.mockResolvedValue(null);
    await expect(importBundledOrg2CloudAuthForDev()).resolves.toBeNull();
  });

  it("rejects a schema-incompatible native payload", async () => {
    invoke.mockResolvedValue(JSON.stringify({ ...VALID_AUTH, kind: "other" }));
    await expect(importBundledOrg2CloudAuthForDev()).rejects.toBeDefined();
  });
});
