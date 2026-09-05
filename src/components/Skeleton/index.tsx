/**
 * Skeleton
 *
 * Static placeholder shapes for loading surfaces.
 *
 * Skeletons deliberately do not animate. A pulsing placeholder that resolves in
 * a few hundred milliseconds paints one partial cycle, so it reads as a grey
 * flash rather than as progress. A skeleton only holds the geometry of the
 * content that is about to arrive; the "something is happening" affordance
 * stays with the surface's own indicator (`LoadingBar`, a status row, or a
 * spinner).
 */
import React from "react";

export interface SkeletonBarProps {
  /** Sizing and shape utilities. The skeleton itself owns only the fill. */
  className?: string;
  /** For surfaces whose loading state is asserted directly by a test. */
  testId?: string;
}

/**
 * One placeholder shape. Rendered as a `span` so it stays valid inside both
 * block and phrasing containers.
 */
const SkeletonBar: React.FC<SkeletonBarProps> = ({
  className = "",
  testId,
}) => (
  <span
    aria-hidden
    data-testid={testId}
    className={`block rounded bg-fill-2 ${className}`.trim()}
  />
);

export default SkeletonBar;
