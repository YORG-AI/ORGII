import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  construct: vi.fn(),
  disk: new Map<string, unknown>(),
  init: vi.fn(async () => {}),
  isTauri: vi.fn(() => true),
  reload: vi.fn(async () => {}),
  save: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: mocks.isTauri,
}));

vi.mock("@tauri-apps/plugin-store", () => ({
  LazyStore: class {
    constructor(path: string, options: unknown) {
      mocks.construct(path, options);
    }

    init = mocks.init;
    reload = mocks.reload;
    save = mocks.save;

    async get<T>(key: string): Promise<T | undefined> {
      return mocks.disk.get(key) as T | undefined;
    }

    async entries<T>(): Promise<Array<[string, T]>> {
      return Array.from(mocks.disk.entries()) as Array<[string, T]>;
    }

    async set(key: string, value: unknown): Promise<void> {
      mocks.disk.set(key, value);
    }

    async delete(key: string): Promise<boolean> {
      return mocks.disk.delete(key);
    }
  },
}));

describe("shared service auth storage", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    mocks.disk.clear();
    mocks.construct.mockClear();
    mocks.init.mockClear();
    mocks.isTauri.mockReset();
    mocks.isTauri.mockReturnValue(true);
    mocks.reload.mockClear();
    mocks.save.mockClear();
  });

  it("migrates the first Tauri origin's existing login state", async () => {
    localStorage.setItem("orgii.supabase.auth", "shared-session");
    localStorage.setItem("hosted_access_token", "access-token");
    localStorage.setItem("orgii:auth_skipped", "1");
    localStorage.setItem("orgii:org2-cloud-v1:auth", '{"kind":"org2_cloud"}');

    const {
      __SHARED_AUTH_STORAGE_INTERNALS,
      initializeSharedServiceAuthStorage,
    } = await import("./sharedAuthStorage");

    await initializeSharedServiceAuthStorage();

    expect(mocks.construct).toHaveBeenCalledWith(
      __SHARED_AUTH_STORAGE_INTERNALS.SHARED_AUTH_STORE_PATH,
      { defaults: {}, autoSave: false }
    );
    expect(mocks.disk.get("orgii.supabase.auth")).toBe("shared-session");
    expect(mocks.disk.get("hosted_access_token")).toBe("access-token");
    expect(mocks.disk.get("orgii:auth_skipped")).toBe("1");
    expect(mocks.disk.get("orgii:org2-cloud-v1:auth")).toBe(
      '{"kind":"org2_cloud"}'
    );
    expect(
      mocks.disk.get(__SHARED_AUTH_STORAGE_INTERNALS.SHARED_AUTH_SCHEMA_KEY)
    ).toBe(__SHARED_AUTH_STORAGE_INTERNALS.SHARED_AUTH_SCHEMA_VERSION);
    expect(mocks.save).toHaveBeenCalledTimes(1);
  });

  it("leaves an empty first origin unclaimed for later migration", async () => {
    const {
      __SHARED_AUTH_STORAGE_INTERNALS,
      initializeSharedServiceAuthStorage,
    } = await import("./sharedAuthStorage");

    await initializeSharedServiceAuthStorage();

    expect(
      mocks.disk.has(__SHARED_AUTH_STORAGE_INTERNALS.SHARED_AUTH_SCHEMA_KEY)
    ).toBe(false);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("keeps the v1 cloud migration open until the bundled origin contributes it", async () => {
    mocks.disk.set("__orgii_shared_auth_schema", 1);

    let authStorage = await import("./sharedAuthStorage");
    await authStorage.initializeSharedServiceAuthStorage();

    expect(mocks.disk.get("__orgii_shared_auth_schema")).toBe(1);
    expect(mocks.disk.has("orgii:org2-cloud-v1:auth")).toBe(false);

    vi.resetModules();
    localStorage.setItem("orgii:org2-cloud-v1:auth", '{"kind":"org2_cloud"}');
    authStorage = await import("./sharedAuthStorage");
    await authStorage.initializeSharedServiceAuthStorage();

    expect(mocks.disk.get("orgii:org2-cloud-v1:auth")).toBe(
      '{"kind":"org2_cloud"}'
    );
    expect(mocks.disk.get("__orgii_shared_auth_schema")).toBe(2);
  });

  it("treats an established shared sign-out as authoritative", async () => {
    const { __SHARED_AUTH_STORAGE_INTERNALS } =
      await import("./sharedAuthStorage");
    mocks.disk.set(
      __SHARED_AUTH_STORAGE_INTERNALS.SHARED_AUTH_SCHEMA_KEY,
      __SHARED_AUTH_STORAGE_INTERNALS.SHARED_AUTH_SCHEMA_VERSION
    );
    localStorage.setItem("orgii.supabase.auth", "stale-session");
    localStorage.setItem("hosted_access_token", "stale-token");
    localStorage.setItem("hosted_refresh_token", "stale-refresh-token");

    const { initializeSharedServiceAuthStorage } =
      await import("./sharedAuthStorage");
    await initializeSharedServiceAuthStorage();

    expect(localStorage.getItem("orgii.supabase.auth")).toBeNull();
    expect(localStorage.getItem("hosted_access_token")).toBeNull();
    expect(localStorage.getItem("hosted_refresh_token")).toBeNull();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("persists Supabase writes and removals to the shared file", async () => {
    const { __SHARED_AUTH_STORAGE_INTERNALS, sharedServiceAuthStorage } =
      await import("./sharedAuthStorage");
    mocks.disk.set(
      __SHARED_AUTH_STORAGE_INTERNALS.SHARED_AUTH_SCHEMA_KEY,
      __SHARED_AUTH_STORAGE_INTERNALS.SHARED_AUTH_SCHEMA_VERSION
    );

    await sharedServiceAuthStorage.setItem(
      "orgii.supabase.auth",
      "new-session"
    );
    expect(mocks.disk.get("orgii.supabase.auth")).toBe("new-session");

    await sharedServiceAuthStorage.removeItem("orgii.supabase.auth");
    expect(mocks.disk.has("orgii.supabase.auth")).toBe(false);
    expect(mocks.save).toHaveBeenCalledTimes(2);
  });

  it("coalesces simultaneous focus-return synchronizations", async () => {
    const {
      __SHARED_AUTH_STORAGE_INTERNALS,
      synchronizeSharedServiceAuthStorage,
    } = await import("./sharedAuthStorage");
    mocks.disk.set(
      __SHARED_AUTH_STORAGE_INTERNALS.SHARED_AUTH_SCHEMA_KEY,
      __SHARED_AUTH_STORAGE_INTERNALS.SHARED_AUTH_SCHEMA_VERSION
    );

    const first = synchronizeSharedServiceAuthStorage();
    const second = synchronizeSharedServiceAuthStorage();

    expect(second).toBe(first);
    await first;
    expect(mocks.reload).toHaveBeenCalledTimes(1);
  });
});
