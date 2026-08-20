/**
 * useOAuthCapture — unit tests for the pure helper functions extracted from the
 * generic hook.  The React hook itself is exercised indirectly via the
 * provider-specific wrappers and integration tests; here we cover the logic
 * that is both pure and most likely to regress during future edits.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  isOAuthE2EMockEnabled,
  parseOAuthCallback,
  shouldNavigateInWebview,
} from "@src/features/SessionSetup/hooks/useOAuthCapture";

// ---------------------------------------------------------------------------
// isOAuthE2EMockEnabled
// ---------------------------------------------------------------------------

describe("isOAuthE2EMockEnabled", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    // Clean up any flag set on window
    delete (window as Record<string, unknown>)["__ORGII_E2E_TEST_MOCK__"];
  });

  it("returns false in production regardless of the window flag", () => {
    process.env.NODE_ENV = "production";
    (window as Record<string, unknown>)["__ORGII_E2E_TEST_MOCK__"] = true;
    expect(isOAuthE2EMockEnabled("__ORGII_E2E_TEST_MOCK__")).toBe(false);
  });

  it("returns false when flag is absent in non-production", () => {
    process.env.NODE_ENV = "test";
    expect(isOAuthE2EMockEnabled("__ORGII_E2E_TEST_MOCK__")).toBe(false);
  });

  it("returns false when flag is false in non-production", () => {
    process.env.NODE_ENV = "test";
    (window as Record<string, unknown>)["__ORGII_E2E_TEST_MOCK__"] = false;
    expect(isOAuthE2EMockEnabled("__ORGII_E2E_TEST_MOCK__")).toBe(false);
  });

  it("returns true when flag is true in non-production", () => {
    process.env.NODE_ENV = "test";
    (window as Record<string, unknown>)["__ORGII_E2E_TEST_MOCK__"] = true;
    expect(isOAuthE2EMockEnabled("__ORGII_E2E_TEST_MOCK__")).toBe(true);
  });

  it("returns false when flag is a non-boolean truthy value", () => {
    process.env.NODE_ENV = "test";
    (window as Record<string, unknown>)["__ORGII_E2E_TEST_MOCK__"] = 1;
    expect(isOAuthE2EMockEnabled("__ORGII_E2E_TEST_MOCK__")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shouldNavigateInWebview
// ---------------------------------------------------------------------------

describe("shouldNavigateInWebview", () => {
  const GOOGLE_DOMAINS = [
    "accounts.google.com",
    "google.com",
    "gstatic.com",
    "cloud.google.com",
  ] as const;

  it("returns true for an exact domain match", () => {
    expect(
      shouldNavigateInWebview(
        "https://accounts.google.com/signin",
        GOOGLE_DOMAINS
      )
    ).toBe(true);
  });

  it("returns true for a subdomain match", () => {
    expect(
      shouldNavigateInWebview(
        "https://sub.gstatic.com/resource.js",
        GOOGLE_DOMAINS
      )
    ).toBe(true);
  });

  it("returns false for a domain that only partially matches (prefix attack)", () => {
    expect(
      shouldNavigateInWebview("https://evil-google.com/page", GOOGLE_DOMAINS)
    ).toBe(false);
  });

  it("returns false for an unlisted domain", () => {
    expect(
      shouldNavigateInWebview("https://example.com/page", GOOGLE_DOMAINS)
    ).toBe(false);
  });

  it("returns false for a malformed URL", () => {
    expect(shouldNavigateInWebview("not-a-url", GOOGLE_DOMAINS)).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(shouldNavigateInWebview("", GOOGLE_DOMAINS)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseOAuthCallback
// ---------------------------------------------------------------------------

describe("parseOAuthCallback", () => {
  const ORIGIN = "http://127.0.0.1:1456";
  const PATH = "/oauth2callback";

  it("returns null for an empty currentUrl", () => {
    expect(parseOAuthCallback("", ORIGIN, PATH)).toBeNull();
  });

  it("returns null for a malformed URL", () => {
    expect(parseOAuthCallback("not-a-url", ORIGIN, PATH)).toBeNull();
  });

  it("returns null when the origin does not match", () => {
    expect(
      parseOAuthCallback(
        "http://evil.com/oauth2callback?code=abc&state=xyz",
        ORIGIN,
        PATH
      )
    ).toBeNull();
  });

  it("returns null when the pathname does not match", () => {
    expect(
      parseOAuthCallback(
        `${ORIGIN}/other-path?code=abc&state=xyz`,
        ORIGIN,
        PATH
      )
    ).toBeNull();
  });

  it("parses a successful callback with code and state", () => {
    const result = parseOAuthCallback(
      `${ORIGIN}${PATH}?code=mycode&state=mystate`,
      ORIGIN,
      PATH
    );
    expect(result).toEqual({
      code: "mycode",
      state: "mystate",
      oauthError: null,
      oauthErrorDescription: null,
    });
  });

  it("parses an error callback with error and error_description", () => {
    const result = parseOAuthCallback(
      `${ORIGIN}${PATH}?error=access_denied&error_description=User+cancelled`,
      ORIGIN,
      PATH
    );
    expect(result).toEqual({
      code: null,
      state: null,
      oauthError: "access_denied",
      oauthErrorDescription: "User cancelled",
    });
  });

  it("parses a callback where only code is present (state missing)", () => {
    const result = parseOAuthCallback(
      `${ORIGIN}${PATH}?code=mycode`,
      ORIGIN,
      PATH
    );
    expect(result).toEqual({
      code: "mycode",
      state: null,
      oauthError: null,
      oauthErrorDescription: null,
    });
  });

  it("uses the exact origin match — port differences are rejected", () => {
    expect(
      parseOAuthCallback(
        "http://127.0.0.1:9999/oauth2callback?code=abc",
        ORIGIN,
        PATH
      )
    ).toBeNull();
  });

  it("works with an https callbackOrigin (ClaudeCode style)", () => {
    const result = parseOAuthCallback(
      "https://platform.claude.com/oauth/code/callback?code=cc_code&state=cc_state",
      "https://platform.claude.com",
      "/oauth/code/callback"
    );
    expect(result).toEqual({
      code: "cc_code",
      state: "cc_state",
      oauthError: null,
      oauthErrorDescription: null,
    });
  });
});
