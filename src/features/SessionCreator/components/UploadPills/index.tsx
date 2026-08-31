/**
 * UploadPills Component
 *
 * Displays uploaded files as interactive pills with remove functionality.
 * Designed to be placed inside input areas above text content.
 * - Image files show as square thumbnails (max 5 images)
 * - Non-image files show as text pills with icons
 *
 * @example
 * <UploadPills
 *   files={uploadedFiles}
 *   onRemove={(fileId) => handleRemoveFile(fileId)}
 * />
 */
import React, { createElement, useCallback, useEffect, useMemo } from "react";

import { createLogger } from "@src/hooks/logger";
import { Cancel01Icon, HugeiconsIcon, Image01Icon } from "@src/icons";
import { getPreviewType } from "@src/util/file/previewTypes";

import { STYLE_CONFIG, getFileTypeIcon } from "./config";
import type { UploadPillProps, UploadPillsProps } from "./types";

const log = createLogger("ImagePill");

// ============================================
// Constants
// ============================================

const MAX_VISIBLE_IMAGES = 5;
const IMAGE_PREVIEW_SIZE = 64; // 64px square

// ============================================
// Image Preview Pill Component
// ============================================

interface ImagePillProps {
  file: UploadPillProps["file"];
  onRemove: () => void;
  className?: string;
}

const ImagePill: React.FC<ImagePillProps> = ({
  file,
  onRemove,
  className = "",
}) => {
  // Create preview URL - prioritize optimized dataUrl from path, fall back to File object
  // Using useMemo to derive URL from file, avoiding setState in effect
  const { previewUrl, isObjectUrl } = useMemo(() => {
    // First check if path contains optimized dataUrl (starts with "data:")
    if (file?.path && file.path.startsWith("data:")) {
      return { previewUrl: file.path, isObjectUrl: false };
    }
    // Fall back to creating object URL from File
    if (file?.file) {
      try {
        return {
          previewUrl: URL.createObjectURL(file.file),
          isObjectUrl: true,
        };
      } catch (error) {
        log.error("[ImagePill] Failed to create object URL:", error);
        return { previewUrl: null, isObjectUrl: false };
      }
    }
    return { previewUrl: null, isObjectUrl: false };
  }, [file]);

  // Cleanup object URL when it changes or component unmounts
  // Only revoke if it's an object URL (not a dataUrl)
  useEffect(() => {
    return () => {
      if (previewUrl && isObjectUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl, isObjectUrl]);

  const handleRemove = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      onRemove();
    },
    [onRemove]
  );

  // Safety check - if file is invalid, show placeholder
  if (!file || !file.id) {
    return (
      <div
        className={`group relative overflow-hidden rounded-[8px] bg-bg-3 ${className}`}
        style={{ width: IMAGE_PREVIEW_SIZE, height: IMAGE_PREVIEW_SIZE }}
      >
        <div className="flex h-full w-full items-center justify-center">
          <HugeiconsIcon
            icon={Image01Icon}
            data-icon="image"
            size={20}
            className="text-text-3"
          />
        </div>
      </div>
    );
  }

  return (
    <div
      className={`group relative overflow-hidden rounded-[8px] bg-bg-2 ${className}`}
      style={{ width: IMAGE_PREVIEW_SIZE, height: IMAGE_PREVIEW_SIZE }}
    >
      {/* Image Preview */}
      {previewUrl ? (
        <img
          src={previewUrl}
          alt={file.name || "Image"}
          className="h-full w-full object-cover"
          onError={(event) => {
            // Hide broken image, show placeholder instead
            (event.target as HTMLImageElement).style.display = "none";
          }}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center bg-bg-3">
          <HugeiconsIcon
            icon={Image01Icon}
            data-icon="image"
            size={20}
            className="text-text-3"
          />
        </div>
      )}

      {/* Remove Button - appears on hover */}
      <button
        className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-bg-overlay text-text-white opacity-0 transition-all hover:bg-bg-overlay-heavy group-hover:opacity-100"
        onClick={handleRemove}
        aria-label={`Remove ${file.name || "image"}`}
      >
        <HugeiconsIcon
          icon={Cancel01Icon}
          data-icon="x"
          size={12}
          strokeWidth={2}
        />
      </button>

      {/* File name tooltip on hover */}
      <div className="absolute bottom-0 left-0 right-0 bg-bg-overlay px-1 py-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <span
          className="block truncate text-[10px] text-text-white"
          title={file.name || "Image"}
        >
          {file.name || "Image"}
        </span>
      </div>
    </div>
  );
};

// ============================================
// Single Pill Component (Non-Image)
// ============================================

const UploadPill: React.FC<UploadPillProps> = ({
  file,
  onRemove,
  className = "",
}) => {
  const handleRemove = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      onRemove();
    },
    [onRemove]
  );

  // Get icon component - using createElement to avoid "component created during render" lint
  const fileIcon = getFileTypeIcon(file.name, file.type);

  return (
    <div
      className={`group relative flex items-center gap-2 rounded-[8px] bg-bg-2 px-3 py-2 ${className}`}
    >
      {/* File Icon */}
      <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-[6px] bg-bg-3">
        {createElement(HugeiconsIcon, {
          icon: fileIcon,
          size: 16,
          className: "text-text-2",
        })}
      </div>

      {/* File Info */}
      <div className="flex flex-col gap-0.5 overflow-hidden">
        <span
          className="truncate text-[13px] font-medium text-text-1"
          style={{ maxWidth: STYLE_CONFIG.maxNameWidth }}
          title={file.name}
        >
          {file.name}
        </span>
        <span className="text-[11px] text-text-3">File</span>
      </div>

      {/* Remove Button */}
      <button
        className="hover:bg-bg-4 absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-bg-3 text-text-3 opacity-0 transition-all hover:text-text-1 group-hover:opacity-100"
        onClick={handleRemove}
        aria-label={`Remove ${file.name}`}
      >
        <HugeiconsIcon
          icon={Cancel01Icon}
          data-icon="x"
          size={10}
          strokeWidth={2}
        />
      </button>
    </div>
  );
};

// ============================================
// Main Component
// ============================================

const UploadPills: React.FC<UploadPillsProps> = ({
  files,
  onRemove,
  maxVisible,
  className = "",
}) => {
  // ============================================
  // Separate Images from Non-Images
  // Note: Hooks must be called before any early returns
  // ============================================

  const { imageFiles, nonImageFiles } = useMemo(() => {
    if (!files || files.length === 0) {
      return { imageFiles: [], nonImageFiles: [] };
    }

    const images: typeof files = [];
    const nonImages: typeof files = [];

    files.forEach((file) => {
      // Skip invalid files
      if (!file || !file.id) return;

      if (
        file.type === "image" ||
        getPreviewType(file.name || "") === "image"
      ) {
        images.push(file);
      } else {
        nonImages.push(file);
      }
    });

    return { imageFiles: images, nonImageFiles: nonImages };
  }, [files]);

  // ============================================
  // Early Return (after hooks)
  // ============================================

  if (!files || files.length === 0) {
    return null;
  }

  // Apply limits
  const displayImages = imageFiles.slice(0, MAX_VISIBLE_IMAGES);
  const hiddenImageCount = Math.max(0, imageFiles.length - MAX_VISIBLE_IMAGES);

  const displayNonImages = maxVisible
    ? nonImageFiles.slice(0, maxVisible)
    : nonImageFiles;
  const hiddenNonImageCount = maxVisible
    ? Math.max(0, nonImageFiles.length - maxVisible)
    : 0;

  // ============================================
  // Render
  // ============================================

  return (
    <div className={`flex flex-col gap-3 ${className}`}>
      {/* Image Previews Row - Square thumbnails */}
      {displayImages.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {displayImages.map((file) => (
            <ImagePill
              key={file.id}
              file={file}
              onRemove={() => onRemove(file.id)}
            />
          ))}

          {/* Hidden image count indicator */}
          {hiddenImageCount > 0 && (
            <div
              className="flex items-center justify-center rounded-[8px] bg-bg-2 text-[12px] text-text-2"
              style={{ width: IMAGE_PREVIEW_SIZE, height: IMAGE_PREVIEW_SIZE }}
            >
              +{hiddenImageCount}
            </div>
          )}
        </div>
      )}

      {/* Non-Image Files Row - Text pills */}
      {displayNonImages.length > 0 && (
        <div className="flex flex-wrap gap-2" style={{ gap: STYLE_CONFIG.gap }}>
          {displayNonImages.map((file) => (
            <UploadPill
              key={file.id}
              file={file}
              onRemove={() => onRemove(file.id)}
            />
          ))}

          {/* Hidden non-image count indicator */}
          {hiddenNonImageCount > 0 && (
            <div className="flex items-center justify-center rounded-[8px] bg-fill-2 px-3 py-2 text-[12px] text-text-2">
              +{hiddenNonImageCount} more
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default UploadPills;
export { UploadPill };
export type { UploadPillProps, UploadPillsProps, UploadedFile } from "./types";
