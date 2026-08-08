/**
 * Background Layer Component
 *
 * Renders the background image with blur effects
 * Extracted from index.tsx background rendering logic
 *
 * Features:
 * - Prevents image flashing during hot reloads via HMR-persistent cache on window
 * - Smooth transitions for blur and transform changes
 * - Trusts cached images immediately (no redundant Image() preload)
 * - Only preloads truly new/uncached images (e.g., user just selected a new background)
 */
import React, { useEffect, useMemo, useRef, useState } from "react";

import { createLogger } from "@src/hooks/logger";
import {
  addToBackgroundCache,
  backgroundImageCache,
} from "@src/util/core/init/backgroundInit";

const log = createLogger("BackgroundLayer");

interface BackgroundLayerProps {
  image: string | null;
  blurAmount: number;
  backgroundColor?: string;
  glass?: "regular" | "medium" | "thick";
}

export const BackgroundLayer: React.FC<BackgroundLayerProps> = ({
  image,
  blurAmount,
  backgroundColor,
  glass,
}) => {
  const [displayedImage, setDisplayedImage] = useState<string | null>(() => {
    if (!image) return null;
    if (backgroundImageCache.has(image)) return image;
    if (image.startsWith("/") || image.startsWith("http")) return image;
    return null;
  });
  const previousImageRef = useRef<string | null>(image);

  useEffect(() => {
    if (image === previousImageRef.current) return;
    previousImageRef.current = image;

    if (!image) {
      queueMicrotask(() => setDisplayedImage(null));
      return;
    }

    if (
      backgroundImageCache.has(image) ||
      image.startsWith("/") ||
      image.startsWith("http") ||
      image.startsWith("blob:")
    ) {
      queueMicrotask(() => setDisplayedImage(image));
      return;
    }

    const img = new Image();
    img.src = image;
    img.onload = () => {
      addToBackgroundCache(image, image);
      setDisplayedImage(image);
    };
    img.onerror = () => {
      log.error("Failed to load background image:", image);
      setDisplayedImage(image);
    };
  }, [image]);

  // If backgroundColor is set and no image, use solid color
  const useColorBackground = backgroundColor && !displayedImage;
  const frameStyle = useMemo<React.CSSProperties>(
    () => ({
      left: 0,
      right: 0,
      height: "100vh",
    }),
    []
  );

  return (
    <div
      className="pointer-events-none absolute top-0 z-0 overflow-hidden"
      style={frameStyle}
      data-background-layer-frame="true"
    >
      <div
        data-background-layer="true"
        className={`absolute inset-0 ${glass != null ? "bg-bg-2" : ""}`}
        style={{
          width: "100%",
          height: "100%",
          opacity: glass != null ? 0.5 : undefined,
          backgroundColor:
            glass == null && useColorBackground ? backgroundColor : undefined,
          backgroundImage:
            glass == null && displayedImage && !backgroundColor
              ? `url(${displayedImage})`
              : "none",
          backgroundSize: "cover",
          backgroundPosition: "center",
          backgroundAttachment: "fixed", // Browser handles at GPU level - zero recalc on resize
          filter: blurAmount > 0 ? `blur(${blurAmount}px)` : "none",
          transform: blurAmount > 0 ? "scale(1.05)" : "translateZ(0)",
          transition:
            "filter 0.3s ease, transform 0.3s ease, background-color 0.3s ease",
          willChange: "transform",
        }}
      />
    </div>
  );
};
