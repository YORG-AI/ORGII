import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ORG2_CLOUD_AUTH_LOOPBACK_TTL_MS,
  ORG2_CLOUD_PENDING_AUTH_STORAGE_KEY,
  beginOrg2CloudAuthLoopback,
  buildOrg2CloudAuthLoopbackUrl,
  cancelPendingOrg2CloudAuthLoopback,
  completePendingOrg2CloudAuthLoopback,
  readPendingOrg2CloudAuthLoopback,
} from "./org2CloudAuthLoopback";

const STATE_A = "b8c71b7e-7ac6-4ebd-aeab-c1976bb01e9d";
const STATE_B = "4f9305ac-9892-42f7-825f-2b7bb7ac99fd";

afterEach(() => {
  completePendingOrg2CloudAuthLoopback(sessionStorage);
  vi.useRealTimers();
});

describe("ORG2 Cloud auth loopback", () => {
  it("builds a localhost callback with the per-login state", () => {
    expect(buildOrg2CloudAuthLoopbackUrl(43123, STATE_A)).toBe(
      `http://localhost:43123/org2-cloud/auth/callback?state=${STATE_A}`
    );
  });

  it("starts one bounded pending flow", async () => {
    vi.useFakeTimers();
    const api = {
      start: vi.fn().mockResolvedValue(43123),
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    const callbackUrl = await beginOrg2CloudAuthLoopback({
      api,
      storage: sessionStorage,
      now: () => 1_000,
      createState: () => STATE_A,
    });

    expect(callbackUrl).toBe(
      `http://localhost:43123/org2-cloud/auth/callback?state=${STATE_A}`
    );
    expect(readPendingOrg2CloudAuthLoopback(sessionStorage)).toEqual({
      callbackUrl,
      port: 43123,
      expiresAtMs: 1_000 + ORG2_CLOUD_AUTH_LOOPBACK_TTL_MS,
    });
    expect(api.start).toHaveBeenCalledTimes(1);
    expect(api.cancel).not.toHaveBeenCalled();
  });

  it("cancels the previous listener before replacing it", async () => {
    vi.useFakeTimers();
    sessionStorage.setItem(
      ORG2_CLOUD_PENDING_AUTH_STORAGE_KEY,
      JSON.stringify({
        callbackUrl: `http://localhost:43122/org2-cloud/auth/callback?state=${STATE_A}`,
        port: 43122,
        expiresAtMs: 50_000,
      })
    );
    const api = {
      start: vi.fn().mockResolvedValue(43123),
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    await beginOrg2CloudAuthLoopback({
      api,
      storage: sessionStorage,
      now: () => 1_000,
      createState: () => STATE_B,
    });

    expect(api.cancel).toHaveBeenCalledWith(43122);
    expect(readPendingOrg2CloudAuthLoopback(sessionStorage)?.port).toBe(43123);
  });

  it("clears and cancels an abandoned listener", async () => {
    sessionStorage.setItem(
      ORG2_CLOUD_PENDING_AUTH_STORAGE_KEY,
      JSON.stringify({
        callbackUrl: `http://localhost:43122/org2-cloud/auth/callback?state=${STATE_A}`,
        port: 43122,
        expiresAtMs: 50_000,
      })
    );
    const api = {
      start: vi.fn(),
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    await cancelPendingOrg2CloudAuthLoopback({
      api,
      storage: sessionStorage,
    });

    expect(api.cancel).toHaveBeenCalledWith(43122);
    expect(readPendingOrg2CloudAuthLoopback(sessionStorage)).toBeNull();
  });

  it("expires an abandoned listener after the bounded TTL", async () => {
    vi.useFakeTimers();
    const api = {
      start: vi.fn().mockResolvedValue(43123),
      cancel: vi.fn().mockResolvedValue(undefined),
    };

    await beginOrg2CloudAuthLoopback({
      api,
      storage: sessionStorage,
      now: () => 1_000,
      createState: () => STATE_A,
    });
    await vi.advanceTimersByTimeAsync(ORG2_CLOUD_AUTH_LOOPBACK_TTL_MS);

    expect(api.cancel).toHaveBeenCalledWith(43123);
    expect(readPendingOrg2CloudAuthLoopback(sessionStorage)).toBeNull();
  });
});
