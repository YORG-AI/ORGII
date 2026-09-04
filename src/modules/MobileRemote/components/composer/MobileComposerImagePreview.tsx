import React, { memo, useCallback } from "react";

import { Cancel01Icon, HugeiconsIcon } from "@src/icons";

import type { MobileComposerImage } from "./useMobileComposerImages";

export interface MobileComposerImagePreviewProps {
  images: MobileComposerImage[];
  onRemove: (id: string) => void;
}

export const MobileComposerImagePreview = memo(
  ({ images, onRemove }: MobileComposerImagePreviewProps) => {
    const handleRemove = useCallback(
      (id: string) => (event: React.MouseEvent) => {
        event.stopPropagation();
        onRemove(id);
      },
      [onRemove]
    );

    if (images.length === 0) return null;

    return (
      <div
        className="flex flex-wrap gap-1.5 px-3 pb-1"
        data-testid="mobile-composer-image-preview"
      >
        {images.map((image) => (
          <div
            key={image.id}
            className="group relative inline-flex h-10 w-10 shrink-0 overflow-hidden rounded-md border border-border-2 bg-fill-1"
            data-testid="mobile-composer-image-thumbnail"
          >
            <img
              src={image.dataUrl}
              alt={image.fileName}
              className="h-full w-full object-cover"
              draggable={false}
              loading="lazy"
              decoding="async"
            />
            <button
              type="button"
              onClick={handleRemove(image.id)}
              className="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-bg-3 text-text-2 shadow-xs hover:bg-fill-2 hover:text-text-1"
              aria-label={image.fileName}
              data-testid="mobile-composer-image-remove"
            >
              <HugeiconsIcon
                icon={Cancel01Icon}
                data-icon="x"
                size={10}
                strokeWidth={2.5}
              />
            </button>
          </div>
        ))}
      </div>
    );
  }
);

MobileComposerImagePreview.displayName = "MobileComposerImagePreview";
