import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchWithTransportRetry,
  fetchWithTransportRetryAndTimeout,
  isFetchTransportError,
  runCloudRequestWithTimeout,
} from "./org2CloudFetchRetry";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("fetchWithTransportRetry", () => {
  it("passes a first-attempt success through without a second request", async () => {
    const response = new Response("ok");
    fetchMock.mockResolvedValueOnce(response);
    await expect(
      fetchWithTransportRetry("https://cloud.test/rpc", { method: "POST" })
    ).resolves.toBe(response);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries EXACTLY once after a transport TypeError (WebKit 'Load failed')", async () => {
    const response = new Response("ok");
    fetchMock
      .mockRejectedValueOnce(new TypeError("Load failed"))
      .mockResolvedValueOnce(response);
    await expect(
      fetchWithTransportRetry("https://cloud.test/rpc", {
        method: "POST",
        body: '{"a":1}',
      })
    ).resolves.toBe(response);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Both attempts carry the identical request.
    expect(fetchMock.mock.calls[0]).toEqual(fetchMock.mock.calls[1]);
  });

  it("surfaces the second failure when both attempts die at the transport", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("Load failed"))
      .mockRejectedValueOnce(new TypeError("Load failed"));
    await expect(
      fetchWithTransportRetry("https://cloud.test/rpc")
    ).rejects.toThrow("Load failed");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry HTTP-level failures (an error Response resolves)", async () => {
    const response = new Response("nope", { status: 500 });
    fetchMock.mockResolvedValueOnce(response);
    await expect(
      fetchWithTransportRetry("https://cloud.test/rpc")
    ).resolves.toBe(response);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry an unrelated programming TypeError", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("x is not a function"));
    await expect(
      fetchWithTransportRetry("https://cloud.test/rpc", { method: "POST" })
    ).rejects.toThrow("x is not a function");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry an abort", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementationOnce(() => {
      controller.abort();
      return Promise.reject(
        new DOMException("The operation was aborted.", "AbortError")
      );
    });
    await expect(
      fetchWithTransportRetry("https://cloud.test/rpc", {
        signal: controller.signal,
      })
    ).rejects.toThrow("aborted");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry when the signal aborted even if the error is a TypeError", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementationOnce(() => {
      controller.abort();
      return Promise.reject(new TypeError("Load failed"));
    });
    await expect(
      fetchWithTransportRetry("https://cloud.test/rpc", {
        signal: controller.signal,
      })
    ).rejects.toThrow("Load failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("fetchWithTransportRetryAndTimeout", () => {
  it("settles at the local deadline even when fetch ignores abort", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(() => new Promise<Response>(() => {}));

    const request = fetchWithTransportRetryAndTimeout(
      "https://cloud.test/rpc",
      { method: "POST" },
      1_000
    );
    const signal = (fetchMock.mock.calls[0]?.[1] as RequestInit).signal;
    const rejected = expect(request).rejects.toMatchObject({
      name: "TimeoutError",
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("settles when the caller aborts even when fetch ignores abort", async () => {
    fetchMock.mockImplementationOnce(() => new Promise<Response>(() => {}));
    const controller = new AbortController();
    const request = fetchWithTransportRetryAndTimeout(
      "https://cloud.test/rpc",
      { signal: controller.signal },
      10_000
    );

    controller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("bounds work after fetch resolves, including a hung body read", async () => {
    vi.useFakeTimers();
    const operation = runCloudRequestWithTimeout(async () => {
      await Promise.resolve("headers");
      return new Promise<string>(() => {});
    }, 1_000);
    const rejected = expect(operation).rejects.toMatchObject({
      name: "TimeoutError",
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
  });
});

describe("isFetchTransportError", () => {
  it.each([
    "Load failed",
    "Failed to fetch",
    "NetworkError when attempting to fetch resource.",
  ])("recognizes the %s transport message", (message) => {
    expect(isFetchTransportError(new TypeError(message))).toBe(true);
  });

  it("rejects ordinary errors and non-TypeErrors", () => {
    expect(isFetchTransportError(new TypeError("x is not a function"))).toBe(
      false
    );
    expect(isFetchTransportError(new Error("Load failed"))).toBe(false);
    expect(isFetchTransportError("Load failed")).toBe(false);
    expect(isFetchTransportError(null)).toBe(false);
  });
});
