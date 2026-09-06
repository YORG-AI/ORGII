// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import { type Root, createRoot } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  type StreamedFileSourceOptions,
  useStreamedFileSource,
} from "./useStreamedFileSource";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  convertFileSrc: vi.fn((path: string) => `asset://localhost${path}`),
  readFile: vi.fn(),
  stat: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  convertFileSrc: mocks.convertFileSrc,
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
  readFile: mocks.readFile,
  stat: mocks.stat,
}));

const objectUrls = {
  created: 0,
  createObjectURL: vi.fn((_blob: Blob) => {
    objectUrls.created += 1;
    return `blob:mock-${objectUrls.created}`;
  }),
  revokeObjectURL: vi.fn(),
};

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let latest: ReturnType<typeof useStreamedFileSource> | null = null;

function Probe(options: StreamedFileSourceOptions) {
  const source = useStreamedFileSource(options);
  useEffect(() => {
    latest = source;
  });
  return null;
}

async function flush(): Promise<void> {
  // Each await lets one queued promise callback in the hook run.
  for (let round = 0; round < 6; round += 1) {
    await act(async () => {});
  }
}

describe("useStreamedFileSource", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(URL, "createObjectURL", {
      value: objectUrls.createObjectURL,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      value: objectUrls.revokeObjectURL,
      configurable: true,
      writable: true,
    });
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    latest = null;
    mocks.stat.mockResolvedValue({ size: 4096 });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  afterAll(() => {
    Reflect.deleteProperty(URL, "createObjectURL");
    Reflect.deleteProperty(URL, "revokeObjectURL");
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  function render(options: StreamedFileSourceOptions) {
    act(() => {
      root.render(createElement(Probe, options));
    });
  }

  it("streams through the asset protocol without reading the file", async () => {
    mocks.invoke.mockResolvedValueOnce("/real/clip.mp4");

    render({ filePath: "/link/clip.mp4", mimeType: "video/mp4" });
    await flush();

    expect(latest?.src).toBe("asset://localhost/real/clip.mp4");
    expect(latest?.fileSize).toBe(4096);
    expect(latest?.loading).toBe(false);
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(objectUrls.createObjectURL).not.toHaveBeenCalled();
  });

  it("falls back to a Blob URL when the file cannot be served, and releases it", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("not a regular file"));
    mocks.readFile.mockResolvedValueOnce(new Uint8Array([1, 2, 3]));

    render({ filePath: "/tmp/clip.mp4", mimeType: "video/mp4" });
    await flush();

    expect(latest?.src).toMatch(/^blob:mock-\d+$/);
    expect(latest?.fileSize).toBe(3);
    const blob = objectUrls.createObjectURL.mock.calls.at(-1)?.[0];
    expect(blob?.type).toBe("video/mp4");

    const url = latest?.src;
    act(() => root.unmount());
    expect(objectUrls.revokeObjectURL).toHaveBeenCalledWith(url);
    root = createRoot(container);
  });

  it("probes the asset URL for elements that cannot report load errors", async () => {
    mocks.invoke.mockResolvedValueOnce("/real/doc.pdf");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false }))
    );
    mocks.readFile.mockResolvedValueOnce(new Uint8Array([9]));

    render({
      filePath: "/real/doc.pdf",
      mimeType: "application/pdf",
      probe: true,
    });
    await flush();

    expect(latest?.src).toMatch(/^blob:mock-\d+$/);
    expect(mocks.readFile).toHaveBeenCalledWith("/real/doc.pdf");
  });

  it("retries with a Blob after the element reports a source error", async () => {
    mocks.invoke.mockResolvedValueOnce("/real/clip.mp4");
    mocks.readFile.mockResolvedValueOnce(new Uint8Array([7, 7]));

    render({ filePath: "/real/clip.mp4", mimeType: "video/mp4" });
    await flush();
    expect(latest?.src).toBe("asset://localhost/real/clip.mp4");

    act(() => {
      latest?.onSourceError();
    });
    await flush();

    expect(latest?.src).toMatch(/^blob:mock-\d+$/);
    expect(latest?.fileSize).toBe(2);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("renders nothing for a null path", async () => {
    render({ filePath: null, mimeType: "application/pdf" });
    await flush();

    expect(latest?.src).toBeNull();
    expect(latest?.loading).toBe(false);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
