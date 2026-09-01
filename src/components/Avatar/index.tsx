/**
 * Avatar Component
 *
 * Native avatar with clean styling. Renders an image when `src` is provided,
 * otherwise renders `children` (text or icon) on a neutral background.
 *
 * @example
 * ```tsx
 * import Avatar from "@src/components/Avatar";
 *
 * <Avatar size={24}>A</Avatar>
 * <Avatar size={32} style={{ backgroundColor: "#1890ff" }}>B</Avatar>
 * <Avatar size={32} src="/me.png" />
 * ```
 */
import React, { memo, useMemo, useState } from "react";

interface AvatarProps {
  /** Avatar size in pixels. @default 32 */
  size?: number;
  /** Avatar content (text or icon). Ignored when `src` is provided. */
  children?: React.ReactNode;
  /** Image URL. */
  src?: string;
  /** Omit the avatar when the image is missing or cannot be loaded. */
  hideOnError?: boolean;
  /** Stable identity used to select a fallback gradient without visual flicker. */
  gradientSeed?: string;
  /** Additional inline style (e.g. `backgroundColor`). */
  style?: React.CSSProperties;
}

const WRAPPER_CLASS =
  "relative inline-flex shrink-0 overflow-hidden rounded-full font-medium";
const DEFAULT_FALLBACK_CLASS = "bg-fill-3 text-text-1";
const GRADIENT_FALLBACK_CLASSES = [
  "bg-linear-to-br from-violet-500 to-fuchsia-500 text-white",
  "bg-linear-to-br from-blue-500 to-cyan-500 text-white",
  "bg-linear-to-br from-emerald-500 to-teal-500 text-white",
  "bg-linear-to-br from-amber-500 to-orange-500 text-white",
  "bg-linear-to-br from-rose-500 to-pink-500 text-white",
  "bg-linear-to-br from-indigo-500 to-purple-500 text-white",
] as const;

function resolveGradientClass(seed: string): string {
  let hash = 0;
  for (const character of seed) {
    hash = (hash * 31 + (character.codePointAt(0) ?? 0)) >>> 0;
  }
  return GRADIENT_FALLBACK_CLASSES[hash % GRADIENT_FALLBACK_CLASSES.length];
}

const Avatar: React.FC<AvatarProps> = ({
  size = 32,
  children,
  src,
  hideOnError = false,
  gradientSeed,
  style,
}) => {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const wrapperStyle = useMemo<React.CSSProperties>(
    () => ({ width: size, height: size, fontSize: size * 0.5, ...style }),
    [size, style]
  );
  const imageFailed = Boolean(src && failedSrc === src);
  const fallbackClass = useMemo(
    () =>
      gradientSeed
        ? resolveGradientClass(gradientSeed)
        : DEFAULT_FALLBACK_CLASS,
    [gradientSeed]
  );

  if (hideOnError && (!src || imageFailed)) return null;

  return (
    <div
      className={`${WRAPPER_CLASS} ${src ? DEFAULT_FALLBACK_CLASS : fallbackClass}`}
      style={wrapperStyle}
    >
      {src ? (
        <img
          src={src}
          alt=""
          className="h-full w-full object-cover"
          onError={
            hideOnError
              ? () => {
                  setFailedSrc(src);
                }
              : undefined
          }
        />
      ) : (
        <span className="absolute inset-0 flex items-center justify-center text-center leading-none">
          {children}
        </span>
      )}
    </div>
  );
};

export default memo(Avatar);
