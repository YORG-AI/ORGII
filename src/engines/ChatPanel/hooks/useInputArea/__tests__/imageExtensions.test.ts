import { describe, expect, it } from "vitest";

import {
  isChatImageFile,
  prepareChatImageFile,
  resolveChatImageMimeType,
} from "../imageExtensions";

describe("imageExtensions chat ingest", () => {
  it("accepts gallery picks with an empty MIME type when the extension is known", () => {
    const file = new File(["pixels"], "IMG_0001.JPG", { type: "" });

    expect(resolveChatImageMimeType(file)).toBe("image/jpeg");
    expect(isChatImageFile(file)).toBe(true);
    expect(prepareChatImageFile(file)?.type).toBe("image/jpeg");
  });

  it("accepts HEIC photos from iOS camera roll", () => {
    const file = new File(["pixels"], "IMG_0001.HEIC", { type: "image/heic" });

    expect(resolveChatImageMimeType(file)).toBe("image/heic");
    expect(prepareChatImageFile(file)?.type).toBe("image/heic");
  });

  it("rejects non-image files", () => {
    const file = new File(["text"], "notes.txt", { type: "text/plain" });

    expect(resolveChatImageMimeType(file)).toBeNull();
    expect(prepareChatImageFile(file)).toBeNull();
  });

  it("rejects SVG attachments for chat image ingest", () => {
    const file = new File(["<svg />"], "icon.svg", { type: "" });

    expect(resolveChatImageMimeType(file)).toBeNull();
    expect(prepareChatImageFile(file)).toBeNull();
  });
});
