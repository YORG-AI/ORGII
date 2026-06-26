/**
 * Background Layer Component
 *
 * Renders the background image with blur effects and optional animation overlays
 * Extracted from index.tsx background rendering logic
 *
 * Features:
 * - Prevents image flashing during hot reloads via HMR-persistent cache on window
 * - Smooth transitions for blur and transform changes
 * - Trusts cached images immediately (no redundant Image() preload)
 * - Only preloads truly new/uncached images (e.g., user just selected a new background)
 * - Supports animation overlays (Matrix, Particles, etc.)
 */
import React, { useEffect, useRef, useState } from "react";

import { createLogger } from "@src/hooks/logger";
import {
  addToBackgroundCache,
  backgroundImageCache,
} from "@src/util/core/init/backgroundInit";
import { isWindows } from "@src/util/platform/tauri";

import { AnimationComponents } from "./animations";

const log = createLogger("BackgroundLayer");

interface BackgroundLayerProps {
  image: string | null;
  blurAmount: number;
  backgroundColor?: string;
  animation?: string;
  glass?: "regular" | "medium" | "thick";
}

export const BackgroundLayer: React.FC<BackgroundLayerProps> = ({
  image,
  blurAmount,
  backgroundColor,
  animation,
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

  // Get animation component if animation is selected
  const AnimationComponent = animation ? AnimationComponents[animation] : null;

  if (isWindows()) {
    return (
      <div
        data-background-layer="true"
        className="absolute left-0 top-0 z-0 bg-bg-2"
        style={{ width: "100vw", height: "100vh" }}
      />
    );
  }

  // Glass mode: render a 30% bg-2 tint behind the native glass effect
  if (glass != null) {
    return (
      <div
        data-background-layer="true"
        className="absolute left-0 top-0 z-0 bg-bg-2"
        style={{ width: "100vw", height: "100vh", opacity: 0.5 }}
      />
    );
  }

  return (
    <>
      {/* Base background layer - absolute with explicit viewport height */}
      <div
        data-background-layer="true"
        className="absolute left-0 top-0 z-0"
        style={{
          width: "100vw",
          height: "100vh",
          backgroundColor: useColorBackground ? backgroundColor : undefined,
          backgroundImage:
            displayedImage && !backgroundColor
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
      {/* Animation overlay layer */}
      {AnimationComponent && <AnimationComponent />}
    </>
  );
};
