/**
 * ImagePreview Component
 *
 * Displays image files with zoom controls and metadata.
 * Supports PNG, JPG, GIF, WebP, SVG, ICO, BMP formats.
 *
 * Features:
 * - Smart fit: fits large images, shows small images at 100%
 * - Zoom controls (fit, 100%, +/-) in bottom bar
 * - Checkerboard background for transparency
 * - Image metadata display (dimensions, format, size)
 * - Loading and error states
 */
import { readFile } from "@tauri-apps/plugin-fs";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { Placeholder } from "@src/components/Placeholder";
import { createLogger } from "@src/hooks/logger";
import { uint8ArrayToDataUrl } from "@src/util/file/binaryUtils";
import { getFileExtensionLower, getFileName } from "@src/util/file/pathUtils";
import { getImageMimeType } from "@src/util/file/previewTypes";

import { ImageBottomBar } from "./ImageBottomBar";
import "./index.scss";

const log = createLogger("ImagePreview");

// ============================================
// Types
// ============================================

export interface ImagePreviewProps {
  /** Absolute file path to the image */
  filePath: string;
  /** Optional class name */
  className?: string;
}

interface ImageMetadata {
  width: number;
  height: number;
  format: string;
  naturalSize: string;
}

// ============================================
// Constants
// ============================================

const ZOOM_LEVELS = [0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5];
const MIN_ZOOM = ZOOM_LEVELS[0];
const MAX_ZOOM = ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
// Padding around image in container
const CONTAINER_PADDING = 32; // 16px on each side

// ============================================
// Helper Functions
// ============================================

/**
 * Get format name from extension
 */
function getFormatName(extension: string): string {
  const formats: Record<string, string> = {
    png: "PNG",
    jpg: "JPEG",
    jpeg: "JPEG",
    gif: "GIF",
    webp: "WebP",
    svg: "SVG",
    ico: "ICO",
    bmp: "BMP",
    avif: "AVIF",
  };
  return formats[extension.toLowerCase()] || extension.toUpperCase();
}

// ============================================
// Main Component
// ============================================

export const ImagePreview: React.FC<ImagePreviewProps> = ({
  filePath,
  className = "",
}) => {
  // Refs
  const containerRef = useRef<HTMLDivElement>(null);

  // State
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [fitMode, setFitMode] = useState(true);
  const [metadata, setMetadata] = useState<ImageMetadata | null>(null);
  const [fileSize, setFileSize] = useState<number | null>(null);

  // File info
  const fileName = useMemo(() => getFileName(filePath), [filePath]);
  const extension = useMemo(() => getFileExtensionLower(filePath), [filePath]);

  // Load image file
  useEffect(() => {
    let cancelled = false;

    async function loadImage() {
      setLoading(true);
      setError(null);
      setImageUrl(null);
      setZoom(1);
      setFitMode(true);
      setMetadata(null);
      setFileSize(null);

      try {
        // Read file as binary
        const data = await readFile(filePath);

        if (cancelled) return;

        // Get MIME type
        const mimeType = getImageMimeType(filePath) || "image/png";

        // Convert to data URL
        const dataUrl = uint8ArrayToDataUrl(data, mimeType);

        // Store file size
        setFileSize(data.byteLength);

        // Set image URL
        setImageUrl(dataUrl);
      } catch (err) {
        if (cancelled) return;
        log.error("Failed to load image:", err);
        setError(err instanceof Error ? err.message : "Failed to load image");
        setLoading(false);
      }
    }

    loadImage();

    return () => {
      cancelled = true;
    };
  }, [filePath]);

  // Handle image load - implements VS Code's smart fit behavior
  const handleImageLoad = useCallback(
    (event: React.SyntheticEvent<HTMLImageElement>) => {
      const img = event.currentTarget;
      const naturalWidth = img.naturalWidth;
      const naturalHeight = img.naturalHeight;

      setMetadata({
        width: naturalWidth,
        height: naturalHeight,
        format: getFormatName(extension),
        naturalSize: `${naturalWidth} × ${naturalHeight}`,
      });

      // Check if image is larger than container (VS Code behavior)
      if (containerRef.current) {
        const containerWidth =
          containerRef.current.clientWidth - CONTAINER_PADDING;
        const containerHeight =
          containerRef.current.clientHeight - CONTAINER_PADDING;

        const imageLargerThanContainer =
          naturalWidth > containerWidth || naturalHeight > containerHeight;

        // If image fits in container, show at actual size (100%)
        // If image is larger, use fit mode
        if (!imageLargerThanContainer) {
          setFitMode(false);
          setZoom(1);
        } else {
          setFitMode(true);
        }
      }

      setLoading(false);
    },
    [extension]
  );

  // Handle image error
  const handleImageError = useCallback(() => {
    setError("Failed to decode image");
    setLoading(false);
  }, []);

  // Zoom controls
  const handleZoomIn = useCallback(() => {
    setFitMode(false);
    setZoom((prev) => {
      const nextLevel = ZOOM_LEVELS.find((level) => level > prev);
      return nextLevel ?? MAX_ZOOM;
    });
  }, []);

  const handleZoomOut = useCallback(() => {
    setFitMode(false);
    setZoom((prev) => {
      const nextLevel = [...ZOOM_LEVELS]
        .reverse()
        .find((level) => level < prev);
      return nextLevel ?? MIN_ZOOM;
    });
  }, []);

  const handleFit = useCallback(() => {
    setFitMode(true);
    setZoom(1);
  }, []);

  const handleActualSize = useCallback(() => {
    setFitMode(false);
    setZoom(1);
  }, []);

  // Error state
  if (error) {
    return (
      <Placeholder
        variant="error"
        placement="detail-panel"
        title={error}
        subtitle={fileName}
        fillParentHeight
        className={className}
      />
    );
  }

  return (
    <div
      className={`image-preview flex h-full min-h-0 flex-col overflow-hidden ${className}`}
    >
      {/* Image container */}
      <div
        ref={containerRef}
        className="image-preview__container relative min-h-0 flex-1 overflow-auto"
      >
        {/* Loading overlay */}
        {loading && (
          <Placeholder
            variant="loading"
            placement="detail-panel"
            fillParentHeight
            className="absolute inset-0 z-10"
          />
        )}

        {/* Image wrapper with checkerboard */}
        {imageUrl && (
          <div
            className={`image-preview__wrapper flex items-center justify-center p-4 ${
              fitMode ? "image-preview__wrapper--fit" : "min-h-full min-w-full"
            }`}
          >
            <div
              className="image-preview__image-container checkerboard-bg"
              style={
                !fitMode
                  ? {
                      transform: `scale(${zoom})`,
                      transformOrigin: "center center",
                    }
                  : undefined
              }
            >
              <img
                src={imageUrl}
                alt={fileName}
                onLoad={handleImageLoad}
                onError={handleImageError}
                className={`image-preview__image ${fitMode ? "image-preview__image--fit" : ""}`}
                draggable={false}
              />
            </div>
          </div>
        )}
      </div>

      {/* Bottom bar with metadata and zoom controls */}
      <ImageBottomBar
        mode="preview"
        metadata={metadata}
        fileSize={fileSize}
        zoom={zoom}
        fitMode={fitMode}
        onFit={handleFit}
        onActualSize={handleActualSize}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        minZoom={MIN_ZOOM}
        maxZoom={MAX_ZOOM}
      />
    </div>
  );
};

export default ImagePreview;
