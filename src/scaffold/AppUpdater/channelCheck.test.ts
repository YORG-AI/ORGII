import { beforeEach, describe, expect, it, vi } from "vitest";

import { checkAppUpdateOnChannel } from "./channelCheck";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getVersion: vi.fn(),
  storeGet: vi.fn(),
}));

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: mocks.getVersion,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("@tauri-apps/plugin-updater", () => ({
  Update: class {
    constructor(metadata: Record<string, unknown>) {
      Object.assign(this, metadata);
    }
  },
}));

vi.mock("@src/util/core/state/instrumentedStore", () => ({
  getInstrumentedStore: () => ({
    get: mocks.storeGet,
  }),
}));

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    rid: 7,
    currentVersion: "1.1.24",
    version: "1.1.25",
    date: null,
    body: null,
    rawJson: {},
    ...overrides,
  };
}

describe("checkAppUpdateOnChannel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.storeGet.mockReturnValue("auto");
    mocks.getVersion.mockResolvedValue("1.1.24");
    mocks.invoke.mockResolvedValue(null);
  });

  it("resolves auto to stable on a release build", async () => {
    await checkAppUpdateOnChannel(30_000);

    expect(mocks.invoke).toHaveBeenCalledWith("check_app_update", {
      channel: "stable",
      timeoutMs: 30_000,
    });
  });

  it("resolves auto to beta on a prerelease build", async () => {
    mocks.getVersion.mockResolvedValue("1.2.0-beta.1");

    await checkAppUpdateOnChannel(30_000);

    expect(mocks.invoke).toHaveBeenCalledWith("check_app_update", {
      channel: "beta",
      timeoutMs: 30_000,
    });
  });

  it("uses an explicitly pinned channel regardless of the build", async () => {
    mocks.storeGet.mockReturnValue("beta");

    await checkAppUpdateOnChannel(30_000);

    expect(mocks.invoke).toHaveBeenCalledWith("check_app_update", {
      channel: "beta",
      timeoutMs: 30_000,
    });
  });

  it("returns null when the channel has no update", async () => {
    expect(await checkAppUpdateOnChannel(30_000)).toBeNull();
  });

  it("wraps metadata in an Update and drops null date/body", async () => {
    mocks.invoke.mockResolvedValue(metadata());

    const update = await checkAppUpdateOnChannel(30_000);

    expect(update).toMatchObject({
      rid: 7,
      currentVersion: "1.1.24",
      version: "1.1.25",
      date: undefined,
      body: undefined,
    });
  });

  it("still checks when the current version cannot be read", async () => {
    mocks.getVersion.mockRejectedValue(new Error("unavailable"));

    await checkAppUpdateOnChannel(30_000);

    expect(mocks.invoke).toHaveBeenCalledWith("check_app_update", {
      channel: "stable",
      timeoutMs: 30_000,
    });
  });
});
