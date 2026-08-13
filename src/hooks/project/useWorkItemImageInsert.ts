/**
 * useWorkItemImageInsert
 *
 * Handles the full image insertion pipeline for work item editors:
 *   File[] -> optimize -> hash -> save to disk -> resolve URL -> insert in editor
 */
import { convertFileSrc } from "@tauri-apps/api/core";
import { type RefObject, useCallback } from "react";

import { projectApi } from "@src/api/http/project";
import { createLogger } from "@src/hooks/logger";
import { optimizeImage } from "@src/util/optimization/imageOptimizer";

const log = createLogger("useWorkItemImageInsert");

interface ImageInsertable {
  insertImage: (src: string, alt?: string) => void;
}

interface UseWorkItemImageInsertOptions {
  projectSlug: string | null;
  editorRef: RefObject<ImageInsertable | null>;
}

async function computeFileHash(data: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function extensionFromMime(mime: string): string {
  const MIME_TO_EXT: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
  };
  return MIME_TO_EXT[mime] ?? "png";
}

export function extensionForOptimizedImage(
  dataUrl: string,
  sourceMime: string
): string {
  const outputMime = /^data:([^;,]+)/u.exec(dataUrl)?.[1] ?? sourceMime;
  return extensionFromMime(outputMime);
}

export function useWorkItemImageInsert({
  projectSlug,
  editorRef,
}: UseWorkItemImageInsertOptions) {
  const handleImageInsert = useCallback(
    async (files: File[]) => {
      if (!projectSlug) return;

      for (const file of files) {
        try {
          const optimized = await optimizeImage(file, {
            maxWidth: 1920,
            maxHeight: 1080,
            quality: 0.85,
            maxFileSizeBytes: 800 * 1024,
          });

          const base64Full = optimized.dataUrl;
          const base64Data = base64Full.split(",")[1];
          if (!base64Data) continue;

          const binaryData = Uint8Array.from(atob(base64Data), (char) =>
            char.charCodeAt(0)
          );
          const hash = await computeFileHash(binaryData.buffer);
          const shortHash = hash.slice(0, 16);
          // optimizeImage can flatten an oversized animation to JPEG. Persist
          // using the produced bytes' MIME type rather than the source suffix.
          const ext = extensionForOptimizedImage(base64Full, file.type);
          const filename = `${shortHash}.${ext}`;

          await projectApi.saveAsset(projectSlug, filename, base64Data);

          const absolutePath = await projectApi.resolveAssetPath(
            projectSlug,
            filename
          );
          const assetUrl = convertFileSrc(absolutePath);

          editorRef.current?.insertImage(assetUrl, file.name);
        } catch (err) {
          log.error("[useWorkItemImageInsert] Failed to insert image:", err);
        }
      }
    },
    [projectSlug, editorRef]
  );

  return { handleImageInsert };
}
