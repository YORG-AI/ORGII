import { afterEach, describe, expect, it, vi } from "vitest";

import {
  INITIAL_CREDENTIAL_DETECTION_STATE,
  credentialDetectionReducer,
  getCredentialDetectionErrorMessage,
  isCredentialDetectionPending,
  withCredentialDetectionTimeout,
} from "../credentialDetectionState";

describe("credentialDetectionState", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  it("tracks the successful credential and model-catalog flow", () => {
    const detecting = credentialDetectionReducer(
      INITIAL_CREDENTIAL_DETECTION_STATE,
      { type: "begin" }
    );
    const loadingCatalog = credentialDetectionReducer(detecting, {
      type: "catalog_requested",
    });
    const success = credentialDetectionReducer(loadingCatalog, {
      type: "succeeded",
      modelCount: 7,
    });

    expect(isCredentialDetectionPending(detecting)).toBe(true);
    expect(isCredentialDetectionPending(loadingCatalog)).toBe(true);
    expect(success).toEqual({ phase: "success", modelCount: 7 });
    expect(isCredentialDetectionPending(success)).toBe(false);
  });

  it("retains the failure reason until the next attempt", () => {
    const failed = credentialDetectionReducer(
      INITIAL_CREDENTIAL_DETECTION_STATE,
      { type: "failed", message: "Model catalog unavailable" }
    );

    expect(failed).toEqual({
      phase: "error",
      message: "Model catalog unavailable",
    });
    expect(credentialDetectionReducer(failed, { type: "begin" })).toEqual({
      phase: "detecting_credentials",
    });
  });

  it("reports multiple credentials before a selection is applied", () => {
    const selecting = credentialDetectionReducer(
      INITIAL_CREDENTIAL_DETECTION_STATE,
      { type: "credentials_found", count: 2 }
    );

    expect(selecting).toEqual({
      phase: "selecting_credential",
      credentialCount: 2,
    });
    expect(isCredentialDetectionPending(selecting)).toBe(false);
  });

  it("preserves a successful detection when the model catalog is empty", () => {
    const success = credentialDetectionReducer(
      INITIAL_CREDENTIAL_DETECTION_STATE,
      { type: "succeeded", modelCount: 0 }
    );

    expect(success).toEqual({ phase: "success", modelCount: 0 });
  });

  it("returns to an idle state when feedback is dismissed", () => {
    const failed = {
      phase: "error" as const,
      message: "No credentials found",
    };

    expect(credentialDetectionReducer(failed, { type: "reset" })).toBe(
      INITIAL_CREDENTIAL_DETECTION_STATE
    );
  });

  it("preserves Error and string rejection reasons with a safe fallback", () => {
    expect(
      getCredentialDetectionErrorMessage(
        new Error("OAuth refresh failed"),
        "Detection failed"
      )
    ).toBe("OAuth refresh failed");
    expect(
      getCredentialDetectionErrorMessage(
        "  Tauri command unavailable  ",
        "Detection failed"
      )
    ).toBe("Tauri command unavailable");
    expect(getCredentialDetectionErrorMessage(null, "Detection failed")).toBe(
      "Detection failed"
    );
  });

  it("rejects a hung operation at the configured deadline", async () => {
    vi.useFakeTimers();
    const operation = new Promise<string>(() => {});
    const bounded = withCredentialDetectionTimeout(
      operation,
      30_000,
      "Request timed out"
    );

    const assertion = expect(bounded).rejects.toThrow("Request timed out");
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });

  it("clears the deadline when the operation settles first", async () => {
    vi.useFakeTimers();

    await expect(
      withCredentialDetectionTimeout(
        Promise.resolve("catalog"),
        30_000,
        "Request timed out"
      )
    ).resolves.toBe("catalog");
    expect(vi.getTimerCount()).toBe(0);
  });
});
