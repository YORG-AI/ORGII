import { describe, expect, it } from "vitest";

import {
  decodeJwtSub,
  isOrg2CloudAuthCallback,
  parseAuthCallbackFragment,
} from "./authCallback";

const VALID_URL =
  "orgii://auth/callback#access_token=header.payload.sig&refresh_token=rt-123&expires_at=1751500000";
const INSTANCE2_CALLBACK_URL = "orgii-instance2://auth/callback";
const INSTANCE2_VALID_URL = VALID_URL.replace("orgii://", "orgii-instance2://");

describe("isOrg2CloudAuthCallback", () => {
  it("matches orgii://auth/callback regardless of fragment validity", () => {
    expect(isOrg2CloudAuthCallback(VALID_URL)).toBe(true);
    expect(isOrg2CloudAuthCallback("orgii://auth/callback")).toBe(true);
    expect(isOrg2CloudAuthCallback("  ORGII://AUTH/CALLBACK/#x=y  ")).toBe(
      true
    );
  });

  it("rejects other schemes and paths", () => {
    expect(isOrg2CloudAuthCallback("yorgai://auth/callback#a=b")).toBe(false);
    expect(isOrg2CloudAuthCallback("orgii://collaboration/join?x=1")).toBe(
      false
    );
    expect(isOrg2CloudAuthCallback("orgii://auth/other#a=b")).toBe(false);
    expect(isOrg2CloudAuthCallback("https://auth/callback#a=b")).toBe(false);
    expect(isOrg2CloudAuthCallback("not a url")).toBe(false);
  });

  it("matches only the isolated desktop instance's configured scheme", () => {
    expect(
      isOrg2CloudAuthCallback(INSTANCE2_VALID_URL, INSTANCE2_CALLBACK_URL)
    ).toBe(true);
    expect(isOrg2CloudAuthCallback(VALID_URL, INSTANCE2_CALLBACK_URL)).toBe(
      false
    );
  });

  it("matches an exact nonce-bound localhost callback", () => {
    const expected =
      "http://localhost:43123/org2-cloud/auth/callback?state=b8c71b7e-7ac6-4ebd-aeab-c1976bb01e9d";
    expect(
      isOrg2CloudAuthCallback(
        `${expected}#access_token=at&refresh_token=rt&expires_at=1751500000`,
        expected
      )
    ).toBe(true);
    expect(
      isOrg2CloudAuthCallback(
        "http://localhost:43123/org2-cloud/auth/callback?state=4f9305ac-9892-42f7-825f-2b7bb7ac99fd#access_token=at",
        expected
      )
    ).toBe(false);
    expect(
      isOrg2CloudAuthCallback(
        "http://localhost:43124/org2-cloud/auth/callback?state=b8c71b7e-7ac6-4ebd-aeab-c1976bb01e9d#access_token=at",
        expected
      )
    ).toBe(false);
  });
});

describe("parseAuthCallbackFragment", () => {
  it("parses a complete fragment", () => {
    expect(parseAuthCallbackFragment(VALID_URL)).toEqual({
      accessToken: "header.payload.sig",
      refreshToken: "rt-123",
      expiresAt: 1751500000,
    });
  });

  it("parses a complete fragment for an isolated desktop instance", () => {
    expect(
      parseAuthCallbackFragment(INSTANCE2_VALID_URL, INSTANCE2_CALLBACK_URL)
    ).toEqual({
      accessToken: "header.payload.sig",
      refreshToken: "rt-123",
      expiresAt: 1751500000,
    });
  });

  it("parses a complete fragment from the expected loopback callback", () => {
    const expected =
      "http://localhost:43123/org2-cloud/auth/callback?state=b8c71b7e-7ac6-4ebd-aeab-c1976bb01e9d";
    expect(
      parseAuthCallbackFragment(
        `${expected}#access_token=header.payload.sig&refresh_token=rt-123&expires_at=1751500000`,
        expected
      )
    ).toEqual({
      accessToken: "header.payload.sig",
      refreshToken: "rt-123",
      expiresAt: 1751500000,
    });
  });

  it("returns null when the fragment is missing", () => {
    expect(parseAuthCallbackFragment("orgii://auth/callback")).toBeNull();
    expect(
      parseAuthCallbackFragment("orgii://auth/callback?access_token=x")
    ).toBeNull();
  });

  it.each([
    [
      "missing access_token",
      "orgii://auth/callback#refresh_token=rt&expires_at=1751500000",
    ],
    [
      "missing refresh_token",
      "orgii://auth/callback#access_token=at&expires_at=1751500000",
    ],
    [
      "missing expires_at",
      "orgii://auth/callback#access_token=at&refresh_token=rt",
    ],
    [
      "empty access_token",
      "orgii://auth/callback#access_token=&refresh_token=rt&expires_at=1751500000",
    ],
    [
      "non-numeric expires_at",
      "orgii://auth/callback#access_token=at&refresh_token=rt&expires_at=soon",
    ],
    [
      "non-positive expires_at",
      "orgii://auth/callback#access_token=at&refresh_token=rt&expires_at=0",
    ],
  ])("returns null for %s", (_name, url) => {
    expect(parseAuthCallbackFragment(url)).toBeNull();
  });

  it("returns null for a non-auth deep link with an auth-looking fragment", () => {
    expect(
      parseAuthCallbackFragment(
        "orgii://collaboration/join#access_token=at&refresh_token=rt&expires_at=1751500000"
      )
    ).toBeNull();
  });
});

describe("decodeJwtSub", () => {
  const jwtWith = (payload: object): string =>
    `x.${btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.y`;

  it("extracts the sub claim", () => {
    expect(
      decodeJwtSub(jwtWith({ sub: "user-1", role: "authenticated" }))
    ).toBe("user-1");
  });

  it("returns null for malformed tokens", () => {
    expect(decodeJwtSub("not-a-jwt")).toBeNull();
    expect(decodeJwtSub("a.b")).toBeNull();
    expect(decodeJwtSub("a.%%%.c")).toBeNull();
    expect(decodeJwtSub(jwtWith({ role: "authenticated" }))).toBeNull();
    expect(decodeJwtSub(jwtWith({ sub: "" }))).toBeNull();
    expect(decodeJwtSub(jwtWith({ sub: 42 }))).toBeNull();
  });
});
