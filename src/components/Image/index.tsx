/**
 * Image Component
 *
 * Enhanced image component with loading, error states, and preview support.
 *
 *
 * Features:
 * - Loading placeholder
 * - Error fallback
 * - Lazy loading
 * - Preview support
 * - Custom placeholder
 * - Object fit control
 *
 * @example
 * ```tsx
 * import Image from "@src/components/Image";
 *
 * // Basic image
 * <Image src="/path/to/image.jpg" alt="Description" />
 *
 * // With loading and error states
 * <Image
 *   src="/path/to/image.jpg"
 *   alt="Description"
 *   loader={<div>Loading image…</div>}
 *   error={<div>Failed to load</div>}
 * />
 *
 * // With preview
 * <Image
 *   src="/path/to/image.jpg"
 *   preview
 * />
 * ```
 */
import { Image as ImageIcon, X } from "lucide-react";
import React, { useEffect, useState } from "react";

import "./index.scss";

export interface ImageProps {
  /**
   * Image source URL
   */
  src: string;

  /**
   * Alt text
   */
  alt?: string;

  /**
   * Image width
   */
  width?: number | string;

  /**
   * Image height
   */
  height?: number | string;

  /**
   * Object fit
   * @default 'cover'
   */
  fit?: "fill" | "contain" | "cover" | "none" | "scale-down";

  /**
   * Enable preview on click
   * @default false
   */
  preview?: boolean;

  /**
   * Custom loading placeholder
   */
  loader?: React.ReactNode;

  /**
   * Custom error fallback
   */
  error?: React.ReactNode;

  /**
   * Lazy loading
   * @default true
   */
  lazyload?: boolean;

  /**
   * Additional class name
   */
  className?: string;

  /**
   * Additional style
   */
  style?: React.CSSProperties;

  /**
   * Click callback
   */
  onClick?: (e: React.MouseEvent) => void;
}

const Image: React.FC<ImageProps> = ({
  src,
  alt = "",
  width,
  height,
  fit = "cover",
  preview = false,
  loader,
  error: errorNode,
  lazyload = true,
  className = "",
  style,
  onClick,
}) => {
  const [loading, setLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  useEffect(() => {
    // Use requestAnimationFrame to avoid synchronous setState in effect
    requestAnimationFrame(() => {
      setLoading(true);
      setHasError(false);
    });
  }, [src]);

  const handleLoad = () => {
    setLoading(false);
    setHasError(false);
  };

  const handleError = () => {
    setLoading(false);
    setHasError(true);
  };

  const handleClick = (e: React.MouseEvent) => {
    if (preview) {
      setShowPreview(true);
    }
    onClick?.(e);
  };

  const handleClosePreview = () => {
    setShowPreview(false);
  };

  useEffect(() => {
    if (!showPreview) {
      return;
    }
    const handlePreviewKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowPreview(false);
      }
    };
    document.addEventListener("keydown", handlePreviewKeyDown);
    return () => document.removeEventListener("keydown", handlePreviewKeyDown);
  }, [showPreview]);

  const imageClasses = ["image", preview && "image-preview-enabled", className]
    .filter(Boolean)
    .join(" ");

  const imageStyle: React.CSSProperties = {
    ...style,
    width,
    height,
    objectFit: fit,
  };

  // Render loading state
  if (loading && !hasError) {
    return (
      <div className={`image-wrapper ${className}`} style={{ width, height }}>
        {loader || (
          <div className="image-loader">
            <ImageIcon size={24} />
          </div>
        )}
      </div>
    );
  }

  // Render error state
  if (hasError) {
    return (
      <div className={`image-wrapper ${className}`} style={{ width, height }}>
        {errorNode || (
          <div className="image-error">
            <ImageIcon size={24} />
            <span>Failed to load</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <img
        src={src}
        alt={alt}
        className={imageClasses}
        style={imageStyle}
        loading={lazyload ? "lazy" : "eager"}
        onLoad={handleLoad}
        onError={handleError}
        onClick={handleClick}
      />

      {/* Preview Modal */}
      {showPreview && (
        <div
          className="image-preview-overlay"
          onClick={handleClosePreview}
          role="dialog"
          aria-modal={true}
          aria-label={alt || "Image preview"}
        >
          <div className="image-preview-content">
            <img src={src} alt={alt} />
            <button
              type="button"
              className="image-preview-close border-none bg-transparent p-0"
              aria-label="Close preview"
              onClick={handleClosePreview}
            >
              <X size={24} />
            </button>
          </div>
        </div>
      )}
    </>
  );
};

export default Image;
