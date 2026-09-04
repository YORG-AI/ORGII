// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import { act, createElement, forwardRef, useImperativeHandle } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chatImageAttachmentsAtom } from "@src/store/ui/chatImageAtom";
import { type SmokeRoot, createSmokeRoot } from "@src/test/reactSmokeHarness";

import { useImageAttachment } from "../useImageAttachment";

vi.mock("@tauri-apps/plugin-fs", () => ({ readFile: vi.fn() }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@src/components/Message", () => ({
  default: { warning: vi.fn(), error: vi.fn(), success: vi.fn() },
}));
vi.mock("@src/hooks/logger", () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
}));
vi.mock("@src/util/optimization/imageOptimizer", () => ({
  optimizeImage: vi.fn(async (file: File) => ({
    dataUrl: `data:${file.type};base64,QUJD`,
    optimizedSize: 3,
    finalDimensions: { width: 1, height: 1 },
  })),
}));

type HookApi = ReturnType<typeof useImageAttachment>;

const Harness = forwardRef<HookApi, { ownerId?: string }>(function Harness(
  { ownerId },
  ref
) {
  const api = useImageAttachment(ownerId);
  useImperativeHandle(ref, () => api, [api]);
  return null;
});

describe("useImageAttachment.handleImagePasteUndoable", () => {
  let root: SmokeRoot;
  let store: ReturnType<typeof createStore>;
  let api: HookApi | null;

  beforeEach(async () => {
    root = createSmokeRoot();
    store = createStore();
    api = null;
    await root.render(
      createElement(
        Provider,
        { store },
        createElement(Harness, {
          ownerId: "composer-a",
          ref: (value: HookApi | null) => {
            api = value;
          },
        })
      )
    );
  });

  afterEach(async () => {
    await root.unmount();
  });

  const images = () => store.get(chatImageAttachmentsAtom);
  const flush = () => act(async () => {});

  it("undo removes exactly the attachments the paste added, redo restores them", async () => {
    store.set(chatImageAttachmentsAtom, [
      {
        id: "pre-existing",
        dataUrl: "data:image/png;base64,QUJD",
        fileName: "kept.png",
        size: 3,
        width: 1,
        height: 1,
        ownerId: "composer-a",
      },
    ]);
    const file = new File(["png"], "shot.png", { type: "image/png" });
    const handle = api!.handleImagePasteUndoable([file]);
    await flush();
    expect(images().map((image) => image.fileName)).toEqual([
      "kept.png",
      "shot.png",
    ]);
    const addedId = images()[1].id;

    act(() => handle.undo());
    await flush();
    expect(images().map((image) => image.id)).toEqual(["pre-existing"]);

    act(() => handle.redo());
    await flush();
    expect(images().map((image) => image.id)).toEqual([
      "pre-existing",
      addedId,
    ]);
    expect(images()[1].ownerId).toBe("composer-a");
  });

  it("undo issued before optimization finishes still removes the attachment", async () => {
    const file = new File(["png"], "late.png", { type: "image/png" });
    const handle = api!.handleImagePasteUndoable([file]);
    act(() => handle.undo());
    await flush();
    expect(images()).toEqual([]);
  });

  it("undo is a no-op for an attachment the user already removed", async () => {
    const file = new File(["png"], "gone.png", { type: "image/png" });
    const handle = api!.handleImagePasteUndoable([file]);
    await flush();
    const id = images()[0].id;
    act(() => api!.removeImage(id));
    expect(images()).toEqual([]);

    act(() => handle.undo());
    await flush();
    expect(images()).toEqual([]);

    act(() => handle.redo());
    await flush();
    expect(images().map((image) => image.id)).toEqual([id]);
  });

  it("ignores non-image files and returns an inert handle", async () => {
    const file = new File(["x"], "notes.txt", { type: "text/plain" });
    const handle = api!.handleImagePasteUndoable([file]);
    await flush();
    expect(images()).toEqual([]);
    act(() => handle.undo());
    act(() => handle.redo());
    await flush();
    expect(images()).toEqual([]);
  });
});
