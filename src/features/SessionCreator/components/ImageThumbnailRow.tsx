/**
 * ImageThumbnailRow
 *
 * Displays image attachment thumbnails in the session creator input.
 * Click opens fullscreen preview; X button removes the image.
 */
import React, { memo, useCallback, useState } from "react";

import ImagePreviewOverlay from "@src/components/ImagePreviewOverlay";
import { Cancel01Icon, HugeiconsIcon } from "@src/icons";
import type { ChatImageAttachment } from "@src/store/ui/chatImageAtom";

// ============================================
// Single Thumbnail
// ============================================

interface ThumbnailProps {
  image: ChatImageAttachment;
  onRemove: (id: string) => void;
}

const Thumbnail: React.FC<ThumbnailProps> = memo(({ image, onRemove }) => {
  const [showOverlay, setShowOverlay] = useState(false);

  const handleRemove = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      onRemove(image.id);
    },
    [image.id, onRemove]
  );

  return (
    <>
      <div
        className="group relative inline-flex h-10 w-10 flex-shrink-0 cursor-pointer overflow-hidden rounded-md border border-border-2 bg-fill-1"
        onClick={() => setShowOverlay(true)}
        data-testid="chat-image-attachment-thumbnail"
        data-image-file-name={image.fileName}
      >
        <img
          src={image.dataUrl}
          alt={image.fileName}
          className="h-full w-full object-cover"
          draggable={false}
          data-testid="chat-image-attachment-img"
        />
        <button
          type="button"
          onClick={handleRemove}
          className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-bg-3 text-text-2 opacity-0 shadow-sm transition-opacity hover:bg-fill-2 hover:text-text-1 group-hover:opacity-100"
          aria-label={`Remove ${image.fileName}`}
          data-testid="chat-image-attachment-remove"
        >
          <HugeiconsIcon
            icon={Cancel01Icon}
            data-icon="x"
            size={10}
            strokeWidth={2.5}
          />
        </button>
      </div>
      {showOverlay && (
        <ImagePreviewOverlay
          dataUrl={image.dataUrl}
          fileName={image.fileName}
          onClose={() => setShowOverlay(false)}
        />
      )}
    </>
  );
});

Thumbnail.displayName = "Thumbnail";

// ============================================
// Row Component
// ============================================

interface ImageThumbnailRowProps {
  images: ChatImageAttachment[];
  onRemove: (id: string) => void;
}

const ImageThumbnailRow: React.FC<ImageThumbnailRowProps> = memo(
  ({ images, onRemove }) => {
    if (images.length === 0) return null;

    return (
      <div
        className="flex flex-wrap gap-1.5 px-3 pb-0.5"
        data-testid="chat-image-attachment-preview"
        data-image-count={images.length}
      >
        {images.map((image) => (
          <Thumbnail key={image.id} image={image} onRemove={onRemove} />
        ))}
      </div>
    );
  }
);

ImageThumbnailRow.displayName = "ImageThumbnailRow";

export default ImageThumbnailRow;
