/**
 * useImageAttachment
 *
 * Single entry point for adding images to the chat input area, regardless of
 * source (paste, drag-drop from OS / file tree, image file picker).  All paths
 * converge on `optimizeImage()` and `chatImageAttachmentsAtom`, so the preview
 * strip (`ImageAttachmentPreview`) renders uniformly.
 *
 *  - `handleImagePaste(files)`    — browser `File[]` (paste event, input element)
 *  - `handleImagePath(path, name?)` — absolute filesystem path (Tauri drag-drop)
 */
import { readFile } from "@tauri-apps/plugin-fs";
import { useAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import Message from "@src/components/Message";
import { createLogger } from "@src/hooks/logger";
import {
  type ChatImageAttachment,
  MAX_CHAT_IMAGES,
  chatImageAttachmentsAtom,
} from "@src/store/ui/chatImageAtom";
import { optimizeImage } from "@src/util/optimization/imageOptimizer";

import {
  isChatImageFile,
  prepareChatImageFile,
  resolveChatImageMimeType,
} from "./imageExtensions";

const log = createLogger("ImageAttachment");

function basename(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || path;
}

function mimeFromPath(path: string): string | undefined {
  return resolveChatImageMimeType(new File([], basename(path))) ?? undefined;
}

export function useImageAttachment(ownerId?: string) {
  const { t } = useTranslation("common");
  const [images, setImages] = useAtom(chatImageAttachmentsAtom);

  const ownerImages = useMemo(
    () =>
      ownerId
        ? images.filter((image) => image.ownerId === ownerId)
        : images.filter((image) => !image.ownerId),
    [images, ownerId]
  );

  // Keep a ref in sync with the current image count so ingestFiles can read
  // the latest value without being recreated on every images.length change.
  const imagesLengthRef = useRef(ownerImages.length);
  useEffect(() => {
    imagesLengthRef.current = ownerImages.length;
  }, [ownerImages.length]);

  /**
   * Shared tail: run each File through `optimizeImage` and push the results
   * into `chatImageAttachmentsAtom`.  Enforces the per-chat image cap (and
   * warns the user if the incoming batch would exceed it).
   */
  const ingestFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;

      const remaining = MAX_CHAT_IMAGES - imagesLengthRef.current;
      if (remaining <= 0) {
        Message.warning(t("chatImage.maxReached", { max: MAX_CHAT_IMAGES }));
        return;
      }

      const filesToProcess = files.slice(0, remaining);
      if (files.length > remaining) {
        Message.warning(
          t("chatImage.remainingWarning", {
            remaining,
            max: MAX_CHAT_IMAGES,
          })
        );
      }

      const newAttachments: ChatImageAttachment[] = [];

      for (const file of filesToProcess) {
        const prepared = prepareChatImageFile(file);
        if (!prepared) continue;

        try {
          const result = await optimizeImage(prepared, {
            maxWidth: 1920,
            maxHeight: 1080,
            quality: 0.85,
            maxFileSizeBytes: 500 * 1024,
          });

          newAttachments.push({
            id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            dataUrl: result.dataUrl,
            fileName: prepared.name || "pasted-image.png",
            size: result.optimizedSize,
            width: result.finalDimensions.width,
            height: result.finalDimensions.height,
            ownerId,
          });
        } catch (error) {
          log.error("Failed to optimize image", error);
          Message.error(t("chatImage.processFailed"));
        }
      }

      if (newAttachments.length > 0) {
        setImages((prev) => [...prev, ...newAttachments]);
      }
    },
    [setImages, ownerId, t]
  );

  const handleImagePaste = useCallback(
    async (files: File[]) => {
      const validFiles = files.filter(isChatImageFile);
      await ingestFiles(validFiles);
    },
    [ingestFiles]
  );

  useEffect(() => {
    const handleE2EImageAttachment = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          eventId?: string;
          fileName?: string;
          dataUrl?: string;
          ownerId?: string;
        }>
      ).detail;
      if (!detail?.dataUrl?.startsWith("data:image/")) return;

      // `useImageAttachment` is mounted by several composers at once (main
      // ChatPanel input, its effects hook, SessionCreator, …) and each
      // registers this listener. A single dispatched event would otherwise be
      // ingested once per mounted instance, attaching the image to every
      // composer. Scope by ownerId so only the intended composer reacts, and
      // dedup by eventId across the duplicate listeners that share one owner.
      if (detail.ownerId !== undefined && detail.ownerId !== (ownerId ?? "")) {
        return;
      }

      const e2eWindow = window as Window & {
        __orgiiE2EImageAttachLast?: Record<string, unknown>;
        __orgiiE2EImageAttachHandled?: Set<string>;
      };
      const eventId = detail.eventId ?? `${detail.fileName}:${detail.dataUrl}`;
      const handled =
        e2eWindow.__orgiiE2EImageAttachHandled ??
        (e2eWindow.__orgiiE2EImageAttachHandled = new Set());
      if (handled.has(eventId)) return;
      handled.add(eventId);

      const [header, base64 = ""] = detail.dataUrl.split(",");
      const mimeMatch = header.match(/^data:([^;]+);base64$/);
      const mime = mimeMatch?.[1] ?? "image/png";
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
      }
      const file = new File([bytes], detail.fileName ?? "e2e-image.png", {
        type: mime,
      });
      e2eWindow.__orgiiE2EImageAttachLast = {
        eventId,
        fileName: detail.fileName,
        received: true,
        mime,
        size: file.size,
        dispatchedToHandleImagePaste: true,
      };
      void handleImagePaste([file]);
    };

    window.addEventListener(
      "orgii:e2e-add-chat-image",
      handleE2EImageAttachment
    );
    return () => {
      window.removeEventListener(
        "orgii:e2e-add-chat-image",
        handleE2EImageAttachment
      );
    };
  }, [handleImagePaste, ownerId]);

  /**
   * Add an image by absolute filesystem path.  Used by the Tauri drag-drop
   * path, where we only have a path string (no browser `File`).  Reads bytes
   * via the fs plugin (home-scoped capability) and wraps them in a `File` so
   * the same optimize pipeline runs.
   */
  const handleImagePath = useCallback(
    async (path: string, fileName?: string) => {
      const mime = mimeFromPath(path);
      if (!mime) {
        // Silently ignore unsupported image types (e.g. .svg) — matches the
        // paste path, which also filters by chat image support.
        return;
      }

      try {
        const bytes = await readFile(path);
        const name = fileName || basename(path);
        const file = new File([bytes as BlobPart], name, { type: mime });
        await ingestFiles([file]);
      } catch (error) {
        const name = fileName || basename(path);
        log.error("Failed to read image from path", { path, error });
        Message.error(t("chatImage.loadFailed", { fileName: name }));
      }
    },
    [ingestFiles, t]
  );

  const clearImages = useCallback(() => {
    setImages((prev) =>
      ownerId
        ? prev.filter((image) => image.ownerId !== ownerId)
        : prev.filter((image) => image.ownerId)
    );
  }, [setImages, ownerId]);

  const removeImage = useCallback(
    (id: string) => {
      setImages((prev) => prev.filter((img) => img.id !== id));
    },
    [setImages]
  );

  /**
   * Restore a previously-captured list of attachments. Used by the
   * composer's submit path to roll back the optimistic clear when the
   * outgoing request fails — without this, the user's images would be
   * silently destroyed on send failure (P1 data loss).
   *
   * The image cap is intentionally NOT re-enforced on restore: the
   * snapshot was already accepted under the cap, and clamping it now
   * would silently drop user content on the failure path.
   */
  const restoreImages = useCallback(
    (snapshot: ChatImageAttachment[]) => {
      const restored = snapshot.map((image) => ({ ...image, ownerId }));
      setImages((prev) => {
        const otherOwners = ownerId
          ? prev.filter((image) => image.ownerId !== ownerId)
          : prev.filter((image) => image.ownerId);
        return [...otherOwners, ...restored];
      });
    },
    [setImages, ownerId]
  );

  return {
    images: ownerImages,
    handleImagePaste,
    handleImagePath,
    clearImages,
    removeImage,
    restoreImages,
    hasImages: ownerImages.length > 0,
  };
}
