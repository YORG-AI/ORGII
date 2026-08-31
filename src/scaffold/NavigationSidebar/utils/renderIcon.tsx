/**
 * Shared renderIcon utility
 *
 * Renders a SidebarIcon (hugeicons glyph data) with optional favicon and
 * loading spinner support.
 */
import React from "react";

import AnyIcon from "@src/components/AnyIcon";

import type { SidebarIcon } from "../types";

interface RenderIconOptions {
  className?: string;
  size?: number;
  /** Favicon URL — renders an <img> instead of an icon */
  faviconUrl?: string;
  /** Show spin animation (for loading states) */
  isLoading?: boolean;
}

/**
 * Render a sidebar icon consistently across all sidebar components.
 *
 * Supports:
 * - Hugeicons glyph data (IconSvgElement)
 * - Favicon URLs (renders <img>)
 * - Loading spinner animation
 */
export function renderSidebarIcon(
  icon: SidebarIcon | undefined,
  options: RenderIconOptions = {}
): React.ReactNode {
  const { className = "", size = 14, faviconUrl, isLoading = false } = options;

  // Favicon image
  if (faviconUrl) {
    return (
      <img
        src={faviconUrl}
        alt=""
        className={`rounded-sm ${className}`}
        style={{ width: size, height: size }}
        onError={(event) => {
          (event.target as HTMLImageElement).style.display = "none";
        }}
      />
    );
  }

  if (!icon) return null;

  // Hugeicons glyph data, rendered through the shared wrapper.
  // strokeWidth is pinned to 2 to preserve the weight lucide rendered at (kept deliberately);
  // hugeicons path data defaults to 1.5.
  const animationClass = isLoading ? "animate-spin" : "";
  const combinedClassName = `${className} ${animationClass}`.trim();

  return (
    <AnyIcon
      icon={icon}
      size={size}
      strokeWidth={2}
      className={combinedClassName}
    />
  );
}
