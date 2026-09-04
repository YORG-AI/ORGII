/**
 * Edit-mode image thumbnail with overlay preview and optional remove (X).
 */
import React, { memo, useCallback, useState } from "react";

import ImagePreviewOverlay from "@src/components/ImagePreviewOverlay";
import { Cancel01Icon, HugeiconsIcon } from "@src/icons";

const EditModeImageThumbnail: React.FC<{
  dataUrl: string;
  alt: string;
  onRemove?: () => void;
}> = memo(({ dataUrl, alt, onRemove }) => {
  const [showOverlay, setShowOverlay] = useState(false);

  const handleClick = useCallback(() => setShowOverlay(true), []);
  const handleClose = useCallback(() => setShowOverlay(false), []);
  const handleRemove = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      onRemove?.();
    },
    [onRemove]
  );

  return (
    <>
      <div
        className="group relative inline-flex h-10 w-10 shrink-0 cursor-pointer overflow-hidden rounded-md border border-border-2 bg-fill-1"
        onClick={handleClick}
        data-testid="edit-mode-image-thumbnail"
      >
        <img
          src={dataUrl}
          alt={alt}
          className="h-full w-full object-cover"
          draggable={false}
          loading="lazy"
          decoding="async"
        />
        {onRemove && (
          <button
            type="button"
            onClick={handleRemove}
            className="absolute -top-0.5 -right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-bg-3 text-text-2 opacity-0 shadow-xs transition-opacity group-hover:opacity-100 hover:bg-fill-2 hover:text-text-1"
            aria-label={`Remove ${alt}`}
            data-testid="edit-mode-image-remove"
          >
            <HugeiconsIcon
              icon={Cancel01Icon}
              data-icon="x"
              size={10}
              strokeWidth={2.5}
            />
          </button>
        )}
      </div>
      {showOverlay && (
        <ImagePreviewOverlay
          dataUrl={dataUrl}
          onClose={handleClose}
          showCopyButton={false}
        />
      )}
    </>
  );
});
EditModeImageThumbnail.displayName = "EditModeImageThumbnail";

export default EditModeImageThumbnail;
