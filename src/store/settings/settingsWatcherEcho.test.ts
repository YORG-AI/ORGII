import { createStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { settings as settingsProcedures } from "@src/api/tauri/rpc/procedures/settings";

import {
  __resetPendingSettingsWrites,
  handleExternalChangeAtom,
  initSettingsAtom,
  settingsAtom,
  updateSettingAtom,
} from "./settingsAtom";

const { rpcCallMock } = vi.hoisted(() => ({ rpcCallMock: vi.fn() }));

vi.mock("@src/api/tauri/rpc/invoke", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@src/api/tauri/rpc/invoke")>();
  return { ...actual, rpcCall: rpcCallMock };
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/**
 * The write queue is module-global, so a test that leaves a write pending would
 * stall every test after it. Each test registers its unresolved writes here.
 */
let pendingWrites: Array<() => void> = [];

function stubRpc(read: Record<string, unknown> = {}) {
  rpcCallMock.mockImplementation((procedure: unknown) => {
    if (procedure === settingsProcedures.read) return Promise.resolve(read);
    const write = deferred<void>();
    pendingWrites.push(() => write.resolve());
    return write.promise;
  });
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * The settings file watcher cannot tell this window's own write apart from a
 * genuine external edit, and reports it with whatever the file held when it
 * read. Before these guards, an edit made while an earlier write was still in
 * flight was reverted by that echo — the "first change does nothing, the second
 * sticks" symptom.
 */
describe("settings watcher echoes", () => {
  beforeEach(() => {
    rpcCallMock.mockReset();
    pendingWrites = [];
    __resetPendingSettingsWrites();
  });

  afterEach(async () => {
    pendingWrites.forEach((resolve) => resolve());
    await flush();
  });

  it("keeps a local write that an in-flight echo has not caught up to", () => {
    stubRpc();
    const store = createStore();

    store.set(updateSettingAtom, {
      key: "general.spotlightPlacement",
      value: "center",
    });
    expect(store.get(settingsAtom)["general.spotlightPlacement"]).toBe(
      "center"
    );

    // Watcher fires with file state that predates the write.
    store.set(handleExternalChangeAtom, {
      "general.spotlightPlacement": "top",
    });

    expect(store.get(settingsAtom)["general.spotlightPlacement"]).toBe(
      "center"
    );
  });

  it("keeps a local write that races the initial read", async () => {
    stubRpc({ "general.spotlightPlacement": "top" });
    const store = createStore();

    store.set(updateSettingAtom, {
      key: "general.spotlightPlacement",
      value: "center",
    });
    await store.set(initSettingsAtom);

    // The read predates the change, so the change must survive it.
    expect(store.get(settingsAtom)["general.spotlightPlacement"]).toBe(
      "center"
    );
  });

  it("accepts a genuine external edit to an untouched key", () => {
    stubRpc();
    const store = createStore();

    store.set(updateSettingAtom, {
      key: "general.spotlightPlacement",
      value: "center",
    });
    store.set(handleExternalChangeAtom, {
      "general.spotlightPlacement": "top",
      "general.uiScale": 125,
    });

    expect(store.get(settingsAtom)["general.spotlightPlacement"]).toBe(
      "center"
    );
    expect(store.get(settingsAtom)["general.uiScale"]).toBe(125);
  });

  it("stops shadowing a key once the file agrees with what was written", async () => {
    stubRpc();
    const store = createStore();

    store.set(updateSettingAtom, {
      key: "general.spotlightPlacement",
      value: "center",
    });
    pendingWrites.forEach((resolve) => resolve());
    await flush();

    // Confirming echo: the file now holds our value, so the claim is released.
    store.set(handleExternalChangeAtom, {
      "general.spotlightPlacement": "center",
    });
    // A later genuine external edit must now win.
    store.set(handleExternalChangeAtom, {
      "general.spotlightPlacement": "top",
    });

    expect(store.get(settingsAtom)["general.spotlightPlacement"]).toBe("top");
  });

  it("lets the newest of two rapid writes to one key win", () => {
    stubRpc();
    const store = createStore();

    store.set(updateSettingAtom, { key: "general.uiScale", value: 110 });
    store.set(updateSettingAtom, { key: "general.uiScale", value: 125 });
    store.set(handleExternalChangeAtom, { "general.uiScale": 100 });

    expect(store.get(settingsAtom)["general.uiScale"]).toBe(125);
  });
});
