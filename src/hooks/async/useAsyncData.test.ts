/* @vitest-environment jsdom */
import React, { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createSmokeRoot } from "@src/test/reactSmokeHarness";

import { type UseAsyncDataReturn, useAsyncData } from "./useAsyncData";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

afterEach(() => vi.clearAllMocks());

describe("useAsyncData", () => {
  it("lets only the latest keyed generation commit", async () => {
    const requests = new Map<string, Deferred<string>>();
    let result: UseAsyncDataReturn<string> | undefined;
    const query = vi.fn((key: string) => {
      const request = deferred<string>();
      requests.set(key, request);
      return request.promise;
    });
    const root = createSmokeRoot();

    function Probe({ queryKey }: { queryKey: string }) {
      const value = useAsyncData({
        key: queryKey,
        query,
        initialData: "initial",
      });
      React.useEffect(() => {
        result = value;
      }, [value]);
      return null;
    }

    await root.render(React.createElement(Probe, { queryKey: "old" }));
    await root.render(React.createElement(Probe, { queryKey: "new" }));
    requests.get("new")?.resolve("new result");
    await flushAsync();
    requests.get("old")?.resolve("stale result");
    await flushAsync();

    expect(result).toMatchObject({ data: "new result", loading: false });
    await root.unmount();
  });

  it("does not query while disabled", async () => {
    const query = vi.fn(async () => "result");
    let result: UseAsyncDataReturn<string> | undefined;
    const root = createSmokeRoot();

    function Probe() {
      const value = useAsyncData({
        key: "stable",
        query,
        initialData: "fallback",
        enabled: false,
      });
      React.useEffect(() => {
        result = value;
      }, [value]);
      return null;
    }

    await root.render(React.createElement(Probe));

    expect(query).not.toHaveBeenCalled();
    expect(result).toMatchObject({ data: "fallback", loading: false });
    await root.unmount();
  });
});
