/**
 * ImageAttachmentPreview
 *
 * Displays pasted/dropped image thumbnails above the chat input.
 * Click opens fullscreen preview overlay with download/close.
 */
import { useAtom } from "jotai";
import { X } from "lucide-react";
import React, { memo, useCallback, useState } from "react";

import ImagePreviewOverlay from "@src/components/ImagePreviewOverlay";
import {
  type ChatImageAttachment,
  chatImageAttachmentsAtom,
} from "@src/store/ui/chatImageAtom";

// ============================================
// Single Image Thumbnail
// ============================================

interface ImageThumbnailProps {
  image: ChatImageAttachment;
  onRemove: (id: string) => void;
}

const ImageThumbnail: React.FC<ImageThumbnailProps> = memo(
  ({ image, onRemove }) => {
    const [showOverlay, setShowOverlay] = useState(false);

    const handleRemove = useCallback(
      (e: React.MouseEvent) => {
        e.stopPropagation();
        onRemove(image.id);
      },
      [image.id, onRemove]
    );

    const handleClick = useCallback(() => {
      setShowOverlay(true);
    }, []);

    const handleCloseOverlay = useCallback(() => {
      setShowOverlay(false);
    }, []);

    return (
      <>
        <div
          className="group relative inline-flex h-10 w-10 flex-shrink-0 cursor-pointer overflow-hidden rounded-md border border-border-2 bg-fill-1"
          onClick={handleClick}
          data-testid="chat-image-attachment-thumbnail"
          data-image-file-name={image.fileName}
        >
          <img
            src={image.dataUrl}
            alt={image.fileName}
            className="h-full w-full object-cover"
            draggable={false}
            loading="lazy"
            decoding="async"
            data-testid="chat-image-attachment-img"
          />
          <button
            type="button"
            onClick={handleRemove}
            className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-bg-3 text-text-2 opacity-0 shadow-sm transition-opacity hover:bg-fill-2 hover:text-text-1 group-hover:opacity-100"
            aria-label={`Remove ${image.fileName}`}
            data-testid="chat-image-attachment-remove"
          >
            <X size={10} strokeWidth={2.5} />
          </button>
        </div>
        {showOverlay && (
          <ImagePreviewOverlay
            dataUrl={image.dataUrl}
            fileName={image.fileName}
            onClose={handleCloseOverlay}
            showCopyButton={false}
          />
        )}
      </>
    );
  }
);

ImageThumbnail.displayName = "ImageThumbnail";

// ============================================
// Main Component
// ============================================

interface ImageAttachmentPreviewProps {
  ownerId?: string;
  className?: string;
}

const ImageAttachmentPreview: React.FC<ImageAttachmentPreviewProps> = memo(
  ({ ownerId, className = "px-3 pb-0.5" }) => {
    const [images, setImages] = useAtom(chatImageAttachmentsAtom);
    const visibleImages = ownerId
      ? images.filter((image) => image.ownerId === ownerId)
      : images.filter((image) => !image.ownerId);

    const handleRemove = useCallback(
      (id: string) => {
        setImages((prev) => prev.filter((img) => img.id !== id));
      },
      [setImages]
    );

    if (visibleImages.length === 0) return null;

    return (
      <div
        className={`flex flex-wrap gap-1.5 ${className}`}
        data-testid="chat-image-attachment-preview"
        data-image-count={visibleImages.length}
      >
        {visibleImages.map((image) => (
          <ImageThumbnail
            key={image.id}
            image={image}
            onRemove={handleRemove}
          />
        ))}
      </div>
    );
  }
);

ImageAttachmentPreview.displayName = "ImageAttachmentPreview";

export default ImageAttachmentPreview;
