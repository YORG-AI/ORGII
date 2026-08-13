import type { Update } from "@tauri-apps/plugin-updater";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { installAppUpdateSeparately } from "./separateInstall";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  channels: [] as unknown[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class MockChannel {
    onmessage?: (event: unknown) => void;

    constructor() {
      mocks.channels.push(this);
    }
  },
  invoke: mocks.invoke,
}));

describe("separate app update installation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.channels.length = 0;
  });

  it("passes the live update resource and progress channel to the native installer", async () => {
    const update = { rid: 42 } as Update;
    const onEvent = vi.fn();
    mocks.invoke.mockResolvedValue({
      targetPath: "/Applications/ORG2.app",
      version: "1.2.6",
    });

    await expect(installAppUpdateSeparately(update, onEvent)).resolves.toEqual({
      targetPath: "/Applications/ORG2.app",
      version: "1.2.6",
    });

    expect(mocks.invoke).toHaveBeenCalledWith(
      "install_app_update_separately",
      expect.objectContaining({ updateRid: 42 })
    );
    expect(mocks.channels).toHaveLength(1);
    expect(
      (mocks.channels[0] as { onmessage?: (event: unknown) => void }).onmessage
    ).toBe(onEvent);
  });
});
