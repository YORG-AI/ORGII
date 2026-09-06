import { afterEach, describe, expect, it, vi } from "vitest";

import {
  probePreviewAssetUrl,
  resolvePreviewAssetUrl,
} from "../previewAssetUrl";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${path}`),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  convertFileSrc: mocks.convertFileSrc,
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("resolvePreviewAssetUrl", () => {
  it("widens the scope for the file and converts the canonical path", async () => {
    mocks.invoke.mockResolvedValueOnce("/real/clip.mp4");

    await expect(resolvePreviewAssetUrl("/link/clip.mp4")).resolves.toBe(
      "asset://localhost//real/clip.mp4"
    );
    expect(mocks.invoke).toHaveBeenCalledWith("allow_preview_asset", {
      filePath: "/link/clip.mp4",
    });
    expect(mocks.convertFileSrc).toHaveBeenCalledWith("/real/clip.mp4");
  });

  it("returns null so callers fall back when the file cannot be served", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("not a regular file"));

    await expect(resolvePreviewAssetUrl("/some/dir")).resolves.toBeNull();
    expect(mocks.convertFileSrc).not.toHaveBeenCalled();
  });
});

describe("probePreviewAssetUrl", () => {
  it("asks for a single byte and reports a served file", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(probePreviewAssetUrl("asset://localhost/x.pdf")).resolves.toBe(
      true
    );
    expect(fetchMock).toHaveBeenCalledWith("asset://localhost/x.pdf", {
      headers: { Range: "bytes=0-0" },
    });
  });

  it("reports failures and network errors as not served", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false }))
    );
    await expect(probePreviewAssetUrl("asset://localhost/x.pdf")).resolves.toBe(
      false
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("blocked");
      })
    );
    await expect(probePreviewAssetUrl("asset://localhost/x.pdf")).resolves.toBe(
      false
    );
  });
});
