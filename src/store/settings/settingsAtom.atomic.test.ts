import { createStore } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { saveSettingsBatchAtom, settingsAtom } from "./settingsAtom";

const { rpcCallMock } = vi.hoisted(() => ({
  rpcCallMock: vi.fn(),
}));

vi.mock("@src/api/tauri/rpc/invoke", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@src/api/tauri/rpc/invoke")>();
  return {
    ...actual,
    rpcCall: rpcCallMock,
  };
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flushQueuedWrite() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("saveSettingsBatchAtom", () => {
  beforeEach(() => {
    rpcCallMock.mockReset();
  });

  it("publishes one matching memory snapshot only after the partial write succeeds", async () => {
    const write = deferred<void>();
    rpcCallMock.mockReturnValueOnce(write.promise);
    const store = createStore();
    const before = store.get(settingsAtom);
    const updates = {
      "general.language": "en" as const,
      "general.theme": "github-dark" as const,
    };

    const saving = store.set(saveSettingsBatchAtom, updates);
    await flushQueuedWrite();

    expect(store.get(settingsAtom)).toEqual(before);
    expect(rpcCallMock).toHaveBeenCalledTimes(1);
    expect(rpcCallMock.mock.calls[0]?.[1]).toEqual({
      partial: updates,
    });

    write.resolve();
    await saving;

    expect(store.get(settingsAtom)).toMatchObject(updates);
  });

  it("leaves memory unchanged when the partial write fails", async () => {
    rpcCallMock.mockRejectedValueOnce(new Error("disk unavailable"));
    const store = createStore();
    const before = store.get(settingsAtom);

    await expect(
      store.set(saveSettingsBatchAtom, {
        "general.language": "en",
      })
    ).rejects.toThrow("disk unavailable");

    expect(store.get(settingsAtom)).toEqual(before);
  });
});
