import { type CSSProperties, memo } from "react";

import { classNames } from "@src/util/ui/classNames";

export interface PearlMarkProps {
  size?: number;
  className?: string;
  title?: string;
}

/**
 * ORGII's pearl mark.
 *
 * The mark stays monochrome and inherits the surrounding text color so it
 * remains legible in every application theme. The lower arcs suggest an open
 * shell without turning the brand into an illustration.
 */
const PearlMark = memo<PearlMarkProps>(({ size = 32, className, title }) => {
  const style: CSSProperties = { width: size, height: size };

  return (
    <span
      className={classNames(
        "inline-flex flex-shrink-0 items-center justify-center",
        className
      )}
      style={style}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 40 40"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        focusable="false"
        aria-hidden="true"
      >
        <circle
          cx="20"
          cy="14.5"
          r="8.5"
          fill="currentColor"
          fillOpacity="0.96"
        />
        <circle
          cx="17.1"
          cy="11.6"
          r="2.1"
          fill="var(--color-bg-2)"
          fillOpacity="0.9"
        />
        <path
          d="M7.5 23.5C10.9 27.2 15.1 29 20 29C24.9 29 29.1 27.2 32.5 23.5"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          opacity="0.62"
        />
        <path
          d="M11.5 29.5C14 32.5 16.8 34 20 34C23.2 34 26 32.5 28.5 29.5"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          opacity="0.3"
        />
      </svg>
    </span>
  );
});

PearlMark.displayName = "PearlMark";

export default PearlMark;
