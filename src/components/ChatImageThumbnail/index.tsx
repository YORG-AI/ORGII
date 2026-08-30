/**
 * ChatImageThumbnail
 *
 * Clickable image thumbnail used by chat surfaces (main chat panel and
 * the WorkStation Communication chat) to render an attached image
 * reference. Click opens `ImagePreviewOverlay` for the full view.
 *
 * Accepts the same heterogeneous reference set Rust emits on
 * `event.result.images`:
 *   1. `data:` URL    — already a data URL, used as-is
 *   2. `asset://`     — Tauri asset protocol URL; the path is extracted
 *                       and read directly via `readFile`
 *   3. absolute path  — read directly via `readFile`
 */
import { readFile } from "@tauri-apps/plugin-fs";
import React, { memo, useCallback, useEffect, useState } from "react";

import ImagePreviewOverlay from "@src/components/ImagePreviewOverlay";
import { HugeiconsIcon, Image01Icon, ImageNotFound01Icon } from "@src/icons";
import { uint8ArrayToDataUrl } from "@src/util/file/binaryUtils";
import { imageRefToRustPath } from "@src/util/file/imageRefs";
import { getImageMimeType } from "@src/util/file/previewTypes";

async function resolveImageSrc(ref: string): Promise<string> {
  if (ref.startsWith("data:")) return ref;

  const filePath = imageRefToRustPath(ref);

  const mimeType = getImageMimeType(filePath) ?? "image/png";
  const data = await readFile(filePath);
  return uint8ArrayToDataUrl(data, mimeType);
}

interface ChatImageThumbnailProps {
  /** Image reference: data URL, asset URL, or absolute file path. */
  imageRef: string;
  /** Alt text for the thumbnail and overlay. */
  alt: string;
  /** Thumbnail size class (default `h-10 w-10`). */
  sizeClassName?: string;
}

export const ChatImageThumbnail: React.FC<ChatImageThumbnailProps> = memo(
  ({ imageRef, alt, sizeClassName = "h-10 w-10" }) => {
    const [showOverlay, setShowOverlay] = useState(false);
    // For `data:` refs we use the ref itself directly — no state needed.
    // For asset/path refs we load the bytes asynchronously into `asyncSrc`.
    // The parent keys items by ref so a ref change remounts this component,
    // which guarantees `asyncSrc` always starts fresh (no stale thumbnail).
    const isDataUrl = imageRef.startsWith("data:");
    const [asyncSrc, setAsyncSrc] = useState<string | null>(null);
    const [loadFailed, setLoadFailed] = useState(false);
    const resolvedSrc = isDataUrl ? imageRef : asyncSrc;

    useEffect(() => {
      if (isDataUrl) return;
      let cancelled = false;
      resolveImageSrc(imageRef)
        .then((src) => {
          if (!cancelled) setAsyncSrc(src);
        })
        .catch(() => {
          if (!cancelled) setLoadFailed(true);
        });
      return () => {
        cancelled = true;
      };
    }, [imageRef, isDataUrl]);

    // Stop propagation so the parent chat row (which may own a click
    // handler for edit-mode in the main chat panel or jump-to-message in
    // the WorkStation chat) does not fire when the user clicks the
    // thumbnail to open the preview.
    const handleClick = useCallback(
      (event: React.MouseEvent) => {
        event.stopPropagation();
        if (resolvedSrc) setShowOverlay(true);
      },
      [resolvedSrc]
    );

    const handleClose = useCallback(() => {
      setShowOverlay(false);
    }, []);

    return (
      <>
        <div
          className={`group relative inline-flex flex-shrink-0 items-center justify-center overflow-hidden rounded-md border border-border-2 bg-fill-1 text-text-3 ${resolvedSrc ? "cursor-pointer" : "cursor-default"} ${sizeClassName}`}
          onClick={handleClick}
          data-image-state={
            resolvedSrc ? "ready" : loadFailed ? "unavailable" : "loading"
          }
        >
          {resolvedSrc ? (
            <img
              src={resolvedSrc}
              alt={alt}
              className="h-full w-full object-cover"
              draggable={false}
              loading="lazy"
              decoding="async"
            />
          ) : loadFailed ? (
            <HugeiconsIcon
              icon={ImageNotFound01Icon}
              data-icon="image-off"
              size={16}
              strokeWidth={1.5}
              aria-label={alt}
            />
          ) : (
            <HugeiconsIcon
              icon={Image01Icon}
              data-icon="image-icon"
              size={16}
              strokeWidth={1.5}
              className="animate-pulse motion-reduce:animate-none"
              aria-label={alt}
            />
          )}
        </div>
        {showOverlay && resolvedSrc && (
          <ImagePreviewOverlay
            dataUrl={resolvedSrc}
            onClose={handleClose}
            showCopyButton={false}
          />
        )}
      </>
    );
  }
);
ChatImageThumbnail.displayName = "ChatImageThumbnail";

interface ChatImageThumbnailRowProps {
  /** Image references (data URLs, asset URLs, or absolute paths). */
  images: string[];
  /** Alt-text prefix (`"<prefix> <n>"`). Defaults to `"Attached image"`. */
  altPrefix?: string;
  /** Thumbnail size class forwarded to each item. */
  sizeClassName?: string;
}

/**
 * Wrap-flow row of thumbnails. Returns `null` when `images` is empty so
 * callers can render unconditionally.
 */
export const ChatImageThumbnailRow: React.FC<ChatImageThumbnailRowProps> = memo(
  ({ images, altPrefix = "Attached image", sizeClassName }) => {
    if (!images || images.length === 0) return null;
    return (
      <div className="flex flex-wrap gap-1.5">
        {images.map((ref, idx) => (
          <ChatImageThumbnail
            key={`${ref}-${idx}`}
            imageRef={ref}
            alt={`${altPrefix} ${idx + 1}`}
            sizeClassName={sizeClassName}
          />
        ))}
      </div>
    );
  }
);
ChatImageThumbnailRow.displayName = "ChatImageThumbnailRow";
