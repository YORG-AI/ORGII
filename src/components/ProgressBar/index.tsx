/**
 * ProgressBar Component
 *
 * A reusable progress bar component for displaying progress percentages.
 * Supports customizable colors, sizes, and animation.
 */
import React, { memo } from "react";

export interface ProgressBarProps {
  /** Progress percentage (0-100) */
  percent: number;
  /** Background color class for the filled portion (default: "bg-primary-6") */
  color?: string;
  /** Height class or pixel value (default: "h-1.5") */
  height?: string | number;
  /** Width - "flex" for flex-1, or a custom width class like "w-24" (default: "flex") */
  width?: "flex" | string;
  /** Whether to show a pulse animation (default: false) */
  animated?: boolean;
  /** Additional className for the container */
  className?: string;
  /** Background color class for the track (default: "bg-fill-3") */
  trackColor?: string;
  /** Accessible label; when provided, exposes progressbar semantics. */
  ariaLabel?: string;
}

export const ProgressBar: React.FC<ProgressBarProps> = memo(
  ({
    percent,
    color = "bg-primary-6",
    height = "h-1.5",
    width = "flex",
    animated = false,
    className = "",
    trackColor = "bg-fill-3",
    ariaLabel,
  }) => {
    const widthClass = width === "flex" ? "flex-1" : width;
    const heightStyle =
      typeof height === "number" ? { height: `${height}px` } : undefined;
    const heightClass = typeof height === "string" ? height : "";

    // Clamp percent between 0 and 100
    const clampedPercent = Math.min(100, Math.max(0, percent));

    return (
      <div
        className={`overflow-hidden rounded-full ${trackColor} ${widthClass} ${heightClass} ${className}`}
        style={heightStyle}
        role={ariaLabel ? "progressbar" : undefined}
        aria-label={ariaLabel}
        aria-valuemin={ariaLabel ? 0 : undefined}
        aria-valuemax={ariaLabel ? 100 : undefined}
        aria-valuenow={ariaLabel ? clampedPercent : undefined}
      >
        <div
          className={`h-full rounded-full ${color} transition-all duration-300 ${
            animated ? "animate-pulse" : ""
          }`}
          style={{ width: `${clampedPercent}%` }}
        />
      </div>
    );
  }
);

ProgressBar.displayName = "ProgressBar";

export default ProgressBar;
