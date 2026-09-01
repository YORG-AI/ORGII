/**
 * AppMark
 *
 * The ORGII application brand mark — the "II" glyph inside a circular
 * frame. Theme-aware: the circle uses a subtle fill token and the glyph
 * inherits `currentColor`, so it adapts to both light and dark themes.
 *
 * Pure display element. Use for chrome (sidebar bottom bar, splash,
 * about dialog) — not for in-content model/provider icons (those live
 * in `ModelIcon`).
 */
import { type CSSProperties, memo } from "react";

import { classNames } from "@src/util/ui/classNames";

const DEFAULT_SIZE = 20;
const GLYPH_SCALE = 0.55;
const VIEW_BOX = "0 0 348 482";
const ROOT_CLASS_NAME =
  "inline-flex flex-shrink-0 items-center justify-center rounded-full bg-fill-2";
const DEFAULT_GLYPH_CLASS_NAME = "text-text-1";

const GLYPH_PATHS = [
  "M339.545 0.5C342.015 0.5 343.959 1.1173 345.282 2.44043C346.605 3.76356 347.223 5.70808 347.223 8.17773C347.223 11.3218 345.704 14.1829 342.78 16.7559C339.865 19.3212 335.526 21.6266 329.802 23.6875L329.794 23.6904C324.196 25.5936 320.023 28.8286 317.242 33.3896C314.456 37.9594 313.043 43.8992 313.043 51.2441V430.639C313.043 438.099 314.456 444.155 317.245 448.84C320.027 453.514 324.2 456.86 329.794 458.876L330.851 459.244C336.054 461.097 340.038 463.165 342.771 465.461C345.696 467.917 347.223 470.667 347.223 473.705C347.223 476.175 346.605 478.119 345.282 479.442C343.959 480.766 342.015 481.383 339.545 481.383H223.676C221.314 481.383 219.452 480.762 218.187 479.434C216.926 478.11 216.34 476.169 216.34 473.705C216.34 470.667 217.867 467.917 220.791 465.461C223.707 463.012 228.045 460.822 233.769 458.876C239.364 456.86 243.537 453.541 246.318 448.923C249.106 444.295 250.52 438.325 250.52 430.98V51.2441C250.52 43.8992 249.107 37.9594 246.32 33.3896C243.539 28.8286 239.366 25.5936 233.769 23.6904L233.761 23.6875C228.036 21.6266 223.697 19.3212 220.782 16.7559C217.858 14.1829 216.34 11.3218 216.34 8.17773C216.34 5.70808 216.957 3.76356 218.28 2.44043C219.603 1.1173 221.548 0.5 224.018 0.5H339.545Z",
  "M123.705 0.5C126.175 0.5 128.119 1.1173 129.442 2.44043C130.766 3.76356 131.383 5.70808 131.383 8.17773C131.383 11.3218 129.864 14.1829 126.94 16.7559C124.025 19.3212 119.687 21.6266 113.962 23.6875L113.954 23.6904C108.357 25.5936 104.183 28.8286 101.402 33.3896C98.6161 37.9594 97.2031 43.8992 97.2031 51.2441V430.639C97.2031 438.099 98.6164 444.155 101.405 448.84C104.188 453.514 108.36 456.86 113.954 458.876L115.011 459.244C120.214 461.097 124.198 463.165 126.932 465.461C129.856 467.917 131.383 470.667 131.383 473.705C131.383 476.175 130.766 478.119 129.442 479.442C128.119 480.766 126.175 481.383 123.705 481.383H7.83594C5.47388 481.383 3.61175 480.762 2.34668 479.434C1.08595 478.11 0.5 476.169 0.5 473.705C0.5 470.667 2.02683 467.917 4.95117 465.461C7.86719 463.012 12.2053 460.822 17.9287 458.876C23.5242 456.86 27.6968 453.541 30.4785 448.923C33.2665 444.295 34.6797 438.325 34.6797 430.98V51.2441C34.6797 43.8992 33.2668 37.9594 30.4805 33.3896C27.6993 28.8286 23.5263 25.5936 17.9287 23.6904L17.9209 23.6875C12.1962 21.6266 7.85757 19.3212 4.94238 16.7559C2.01864 14.1829 0.5 11.3218 0.5 8.17773C0.5 5.70808 1.1173 3.76356 2.44043 2.44043C3.76356 1.1173 5.70808 0.5 8.17773 0.5H123.705Z",
] as const;

interface AppMarkProps {
  /** Outer size in pixels (the full circle). Defaults to 20. */
  size?: number;
  /** Extra classes on the outer wrapper. */
  className?: string;
  /** Override the inner glyph color (defaults to inheriting currentColor). */
  glyphClassName?: string;
  /** Accessible label. Omit to keep the mark decorative. */
  title?: string;
}

const AppMark = memo<AppMarkProps>(
  ({
    size = DEFAULT_SIZE,
    className,
    glyphClassName = DEFAULT_GLYPH_CLASS_NAME,
    title,
  }) => {
    // Glyph takes ~55% of the circle diameter so it has clear breathing room.
    const glyphSize = Math.round(size * GLYPH_SCALE);
    const rootStyle: CSSProperties = { width: size, height: size };
    const isDecorative = !title;

    return (
      <span
        className={classNames(ROOT_CLASS_NAME, className)}
        style={rootStyle}
        aria-hidden={isDecorative || undefined}
        aria-label={title}
        role={title ? "img" : undefined}
      >
        <svg
          width={glyphSize}
          height={glyphSize}
          viewBox={VIEW_BOX}
          fill="currentColor"
          xmlns="http://www.w3.org/2000/svg"
          className={glyphClassName}
          aria-hidden="true"
          focusable="false"
        >
          {GLYPH_PATHS.map((path) => (
            <path key={path} d={path} />
          ))}
        </svg>
      </span>
    );
  }
);

AppMark.displayName = "AppMark";

export default AppMark;
