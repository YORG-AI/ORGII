// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { getApiCalls } from "../apiTrackerCalls";
import { installXmlHttpRequestTracking } from "../apiTrackerHttp";
import { clearPushEvents, getPushHotspots } from "../apiTrackerPush";
import {
  clearApiCallRecords,
  disableTrackingState,
  enableTrackingState,
} from "../apiTrackerState";
import { installTauriCallbackTracking } from "../apiTrackerTauri";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  disableTrackingState();
  clearApiCallRecords();
  clearPushEvents();
  vi.restoreAllMocks();
});

describe("API tracker transport coverage", () => {
  it("records direct XMLHttpRequest traffic", () => {
    const prototype = window.XMLHttpRequest.prototype;
    const originalOpen = prototype.open;
    const originalSend = prototype.send;

    prototype.open = vi.fn() as unknown as XMLHttpRequest["open"];
    prototype.send = vi.fn(function fakeSend(this: XMLHttpRequest) {
      this.dispatchEvent(new Event("loadend"));
    });

    const cleanup = installXmlHttpRequestTracking();
    cleanups.push(() => {
      cleanup?.();
      prototype.open = originalOpen;
      prototype.send = originalSend;
    });
    enableTrackingState();

    const request = new XMLHttpRequest();
    request.open("POST", "/upload");
    request.send("payload");

    expect(getApiCalls()).toMatchObject([
      {
        method: "POST",
        url: "/upload",
        transport: "http",
      },
    ]);
  });

  it("records Tauri events delivered to direct listeners", () => {
    const originalInternals = (
      window as unknown as { __TAURI_INTERNALS__?: unknown }
    ).__TAURI_INTERNALS__;
    const runCallback = vi.fn();
    (
      window as unknown as {
        __TAURI_INTERNALS__: { runCallback: typeof runCallback };
      }
    ).__TAURI_INTERNALS__ = { runCallback };

    const cleanup = installTauriCallbackTracking();
    cleanups.push(() => {
      cleanup?.();
      (
        window as unknown as { __TAURI_INTERNALS__?: unknown }
      ).__TAURI_INTERNALS__ = originalInternals;
    });
    enableTrackingState();

    (
      window as unknown as {
        __TAURI_INTERNALS__: {
          runCallback: (callbackId: number, data: unknown) => void;
        };
      }
    ).__TAURI_INTERNALS__.runCallback(42, {
      event: "orgii-data-changed",
      payload: null,
    });

    expect(getPushHotspots()).toMatchObject([
      {
        kind: "tauri-event",
        name: "orgii-data-changed",
        count: 1,
      },
    ]);
    expect(runCallback).toHaveBeenCalledOnce();
  });
});
