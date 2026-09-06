import { afterEach, describe, expect, it, vi } from "vitest";

import { releaseImageUrl, uint8ArrayToImageUrl } from "../binaryUtils";

function withoutObjectUrls<T>(run: () => T): T {
  const original = URL.createObjectURL;
  Object.defineProperty(URL, "createObjectURL", {
    value: undefined,
    configurable: true,
    writable: true,
  });
  try {
    return run();
  } finally {
    Object.defineProperty(URL, "createObjectURL", {
      value: original,
      configurable: true,
      writable: true,
    });
  }
}

describe("uint8ArrayToImageUrl", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("wraps the bytes in a typed Blob and returns its object URL", () => {
    const create = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:test-1");

    const url = uint8ArrayToImageUrl(new Uint8Array([1, 2, 3]), "image/png");

    expect(url).toBe("blob:test-1");
    expect(create).toHaveBeenCalledTimes(1);
    const blob = create.mock.calls[0][0] as Blob;
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("image/png");
    expect(blob.size).toBe(3);
  });

  it("falls back to a base64 data URL where object URLs are unavailable", () => {
    const url = withoutObjectUrls(() =>
      uint8ArrayToImageUrl(new Uint8Array([1, 2, 3]), "image/png")
    );
    expect(url).toBe("data:image/png;base64,AQID");
  });

  it("encodes large buffers in the fallback without losing bytes", () => {
    const bytes = new Uint8Array(100_000);
    for (let idx = 0; idx < bytes.length; idx += 1) bytes[idx] = idx % 251;
    const url = withoutObjectUrls(() =>
      uint8ArrayToImageUrl(bytes, "image/webp")
    );
    expect(url.startsWith("data:image/webp;base64,")).toBe(true);
    const decoded = atob(url.slice("data:image/webp;base64,".length));
    expect(decoded.length).toBe(bytes.length);
    expect(decoded.charCodeAt(99_999)).toBe(99_999 % 251);
  });
});

describe("releaseImageUrl", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("revokes blob URLs only", () => {
    const revoke = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => undefined);

    releaseImageUrl("blob:test-1");
    releaseImageUrl("data:image/png;base64,AQID");
    releaseImageUrl("asset://localhost/x.png");
    releaseImageUrl(null);
    releaseImageUrl(undefined);

    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith("blob:test-1");
  });
});
