import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  construct: vi.fn(),
  disk: new Map<string, unknown>(),
  init: vi.fn(async () => {}),
  isTauri: vi.fn(() => true),
  reload: vi.fn(async () => {}),
  save: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri }));

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

describe("legacy Cloud auth migration storage", () => {
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

  it("migrates only the Cloud rollback envelope and retires Hosted secrets", async () => {
    localStorage.setItem("orgii.supabase.auth", "retired-session");
    localStorage.setItem("hosted_access_token", "retired-access");
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
    expect(mocks.disk.get("orgii:org2-cloud-v1:auth")).toBe(
      '{"kind":"org2_cloud"}'
    );
    expect(mocks.disk.has("orgii.supabase.auth")).toBe(false);
    expect(mocks.disk.has("hosted_access_token")).toBe(false);
    expect(mocks.disk.has("orgii:auth_skipped")).toBe(false);
    expect(localStorage.getItem("orgii.supabase.auth")).toBeNull();
    expect(localStorage.getItem("hosted_access_token")).toBeNull();
    expect(localStorage.getItem("orgii:auth_skipped")).toBe("1");
    expect(
      mocks.disk.get(__SHARED_AUTH_STORAGE_INTERNALS.SHARED_AUTH_SCHEMA_KEY)
    ).toBe(__SHARED_AUTH_STORAGE_INTERNALS.SHARED_AUTH_SCHEMA_VERSION);
  });

  it("leaves an empty first origin unclaimed for later Cloud migration", async () => {
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

  it("keeps a v1 Cloud migration open until a bundled origin contributes it", async () => {
    mocks.disk.set("__orgii_shared_auth_schema", 1);

    let authStorage = await import("./sharedAuthStorage");
    await authStorage.initializeSharedServiceAuthStorage();
    expect(mocks.disk.get("__orgii_shared_auth_schema")).toBe(1);

    vi.resetModules();
    localStorage.setItem("orgii:org2-cloud-v1:auth", '{"kind":"org2_cloud"}');
    authStorage = await import("./sharedAuthStorage");
    await authStorage.initializeSharedServiceAuthStorage();

    expect(mocks.disk.get("orgii:org2-cloud-v1:auth")).toBe(
      '{"kind":"org2_cloud"}'
    );
    expect(mocks.disk.get("__orgii_shared_auth_schema")).toBe(3);
  });

  it("treats an established shared Cloud sign-out as authoritative", async () => {
    const { __SHARED_AUTH_STORAGE_INTERNALS } =
      await import("./sharedAuthStorage");
    mocks.disk.set(
      __SHARED_AUTH_STORAGE_INTERNALS.SHARED_AUTH_SCHEMA_KEY,
      __SHARED_AUTH_STORAGE_INTERNALS.SHARED_AUTH_SCHEMA_VERSION
    );
    localStorage.setItem("orgii:org2-cloud-v1:auth", "stale-cloud-session");

    const { initializeSharedServiceAuthStorage } =
      await import("./sharedAuthStorage");
    await initializeSharedServiceAuthStorage();

    expect(localStorage.getItem("orgii:org2-cloud-v1:auth")).toBeNull();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("stages and deletes only the migration-only Cloud envelope", async () => {
    const {
      __SHARED_AUTH_STORAGE_INTERNALS,
      deleteLegacyOrg2CloudAuthEnvelope,
      flushSharedServiceAuthStorage,
      stageLegacyOrg2CloudAuthEnvelope,
    } = await import("./sharedAuthStorage");
    mocks.disk.set(
      __SHARED_AUTH_STORAGE_INTERNALS.SHARED_AUTH_SCHEMA_KEY,
      __SHARED_AUTH_STORAGE_INTERNALS.SHARED_AUTH_SCHEMA_VERSION
    );

    stageLegacyOrg2CloudAuthEnvelope('{"kind":"org2_cloud"}');
    await flushSharedServiceAuthStorage();
    expect(mocks.disk.get("orgii:org2-cloud-v1:auth")).toBe(
      '{"kind":"org2_cloud"}'
    );

    await deleteLegacyOrg2CloudAuthEnvelope();
    expect(mocks.disk.has("orgii:org2-cloud-v1:auth")).toBe(false);
    expect(localStorage.getItem("orgii:org2-cloud-v1:auth")).toBeNull();
  });

  it("deletes retired Hosted keys from disk during schema upgrade", async () => {
    mocks.disk.set("__orgii_shared_auth_schema", 2);
    mocks.disk.set("hosted_refresh_token", "retired-refresh");
    mocks.disk.set("orgii.supabase.auth-code-verifier", "retired-verifier");
    localStorage.setItem("hosted_refresh_token", "retired-refresh");
    localStorage.setItem("orgii:auth_skipped", "1");

    const { initializeSharedServiceAuthStorage } =
      await import("./sharedAuthStorage");
    await initializeSharedServiceAuthStorage();

    expect(mocks.disk.has("hosted_refresh_token")).toBe(false);
    expect(mocks.disk.has("orgii.supabase.auth-code-verifier")).toBe(false);
    expect(localStorage.getItem("hosted_refresh_token")).toBeNull();
    expect(localStorage.getItem("orgii:auth_skipped")).toBe("1");
    expect(mocks.disk.get("__orgii_shared_auth_schema")).toBe(3);
  });
});
