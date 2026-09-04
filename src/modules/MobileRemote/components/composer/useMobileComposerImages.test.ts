// @vitest-environment jsdom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MAX_CHAT_IMAGES } from "@src/store/ui/chatImageAtom";

import { useMobileComposerImages } from "./useMobileComposerImages";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock("@src/util/optimization/imageOptimizer", () => ({
  optimizeImage: vi.fn(async (file: File) => ({
    dataUrl: `data:image/jpeg;base64,${file.name}`,
    optimizedSize: 100,
    originalSize: 200,
    wasOptimized: true,
    originalDimensions: { width: 100, height: 100 },
    finalDimensions: { width: 100, height: 100 },
  })),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type HookResult = ReturnType<typeof useMobileComposerImages>;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const hookHolder: { current: HookResult | null } = { current: null };

function Harness() {
  // Test harness captures the latest hook return for assertions.
  // eslint-disable-next-line react-hooks/immutability -- intentional test sink
  hookHolder.current = useMobileComposerImages();
  return null;
}

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
  }
  host?.remove();
  root = null;
  host = null;
  hookHolder.current = null;
});

async function mountHarness() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(Harness));
  });
}

function hookApi(): HookResult {
  if (!hookHolder.current) {
    throw new Error("useMobileComposerImages harness is not mounted");
  }
  return hookHolder.current;
}

describe("useMobileComposerImages", () => {
  it("ingests image files and exposes send attachments", async () => {
    await mountHarness();
    const file = new File(["pixels"], "photo.jpg", { type: "image/jpeg" });

    await act(async () => {
      await hookApi().ingestFiles([file]);
    });

    expect(hookApi().hasImages).toBe(true);
    expect(hookApi().images).toHaveLength(1);
    expect(hookApi().toSendAttachments()).toEqual([
      {
        dataUrl: "data:image/jpeg;base64,photo.jpg",
        fileName: "photo.jpg",
      },
    ]);
  });

  it("ingests gallery photos when the browser omits file.type", async () => {
    await mountHarness();
    const file = new File(["pixels"], "IMG_0001.JPG", { type: "" });

    await act(async () => {
      await hookApi().ingestFiles([file]);
    });

    expect(hookApi().hasImages).toBe(true);
    expect(hookApi().images).toHaveLength(1);
    expect(hookApi().error).toBeUndefined();
  });

  it("ingests HEIC photos from mobile camera roll", async () => {
    await mountHarness();
    const file = new File(["pixels"], "IMG_0001.HEIC", {
      type: "image/heic",
    });

    await act(async () => {
      await hookApi().ingestFiles([file]);
    });

    expect(hookApi().hasImages).toBe(true);
    expect(hookApi().images).toHaveLength(1);
    expect(hookApi().error).toBeUndefined();
  });

  it("rejects unsupported file types", async () => {
    await mountHarness();
    const file = new File(["text"], "notes.txt", { type: "text/plain" });

    await act(async () => {
      await hookApi().ingestFiles([file]);
    });

    expect(hookApi().hasImages).toBe(false);
    expect(hookApi().error).toBeTruthy();
  });

  it("enforces the shared chat image cap", async () => {
    await mountHarness();
    const files = Array.from(
      { length: MAX_CHAT_IMAGES + 1 },
      (_, index) =>
        new File(["pixels"], `photo-${index}.jpg`, { type: "image/jpeg" })
    );

    await act(async () => {
      await hookApi().ingestFiles(files);
    });

    expect(hookApi().images).toHaveLength(MAX_CHAT_IMAGES);
    expect(hookApi().error).toBeTruthy();
  });
});
