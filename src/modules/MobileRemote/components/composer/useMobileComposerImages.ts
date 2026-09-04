import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { MobileSendAttachment } from "@src/modules/MobileRemote/connection/types";
import { MAX_CHAT_IMAGES } from "@src/store/ui/chatImageAtom";
import { optimizeImage } from "@src/util/optimization/imageOptimizer";

const ACCEPTED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
]);

export interface MobileComposerImage {
  id: string;
  dataUrl: string;
  fileName: string;
}

export function useMobileComposerImages() {
  const { t } = useTranslation("mobileRemote");
  const [images, setImages] = useState<MobileComposerImage[]>([]);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string>();
  const imagesLengthRef = useRef(0);

  imagesLengthRef.current = images.length;

  const ingestFiles = useCallback(
    async (files: File[]) => {
      const validFiles = files.filter((file) =>
        ACCEPTED_IMAGE_TYPES.has(file.type)
      );
      if (validFiles.length === 0) {
        if (files.length > 0) {
          setError(t("composer.attachments.unsupportedType"));
        }
        return;
      }

      const remaining = MAX_CHAT_IMAGES - imagesLengthRef.current;
      if (remaining <= 0) {
        setError(
          t("composer.attachments.maxReached", { max: MAX_CHAT_IMAGES })
        );
        return;
      }

      const filesToProcess = validFiles.slice(0, remaining);
      if (validFiles.length > remaining) {
        setError(
          t("composer.attachments.remainingWarning", {
            remaining,
            max: MAX_CHAT_IMAGES,
          })
        );
      } else {
        setError(undefined);
      }

      setProcessing(true);
      const newImages: MobileComposerImage[] = [];

      try {
        for (const file of filesToProcess) {
          try {
            const result = await optimizeImage(file, {
              maxWidth: 1920,
              maxHeight: 1080,
              quality: 0.85,
              maxFileSizeBytes: 500 * 1024,
            });
            newImages.push({
              id: `mobile-img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              dataUrl: result.dataUrl,
              fileName: file.name || "photo.jpg",
            });
          } catch {
            setError(t("composer.attachments.processFailed"));
          }
        }

        if (newImages.length > 0) {
          setImages((prev) => [...prev, ...newImages]);
        }
      } finally {
        setProcessing(false);
      }
    },
    [t]
  );

  const removeImage = useCallback((id: string) => {
    setImages((prev) => prev.filter((image) => image.id !== id));
    setError(undefined);
  }, []);

  const clearImages = useCallback(() => {
    setImages([]);
    setError(undefined);
  }, []);

  const toSendAttachments = useCallback((): MobileSendAttachment[] => {
    return images.map(({ dataUrl, fileName }) => ({ dataUrl, fileName }));
  }, [images]);

  return {
    images,
    hasImages: images.length > 0,
    processing,
    error,
    ingestFiles,
    removeImage,
    clearImages,
    toSendAttachments,
  };
}
