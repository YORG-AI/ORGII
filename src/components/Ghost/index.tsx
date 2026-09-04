/**
 * Ghost
 *
 * Static placeholder shapes for loading surfaces.
 *
 * Ghosts deliberately do not animate. A pulsing skeleton that resolves in a
 * few hundred milliseconds reads as a grey flash rather than as progress, so
 * a ghost only holds the loaded layout's geometry. The "something is
 * happening" affordance stays with the surface's own indicator (`LoadingBar`,
 * a status row, or a spinner).
 */
import React from "react";

export interface GhostBarProps {
  /** Sizing and shape utilities. The ghost itself owns only the fill. */
  className?: string;
}

/**
 * One placeholder shape. Rendered as a `span` so it stays valid inside both
 * block and phrasing containers.
 */
const GhostBar: React.FC<GhostBarProps> = ({ className = "" }) => (
  <span aria-hidden className={`block rounded bg-fill-2 ${className}`.trim()} />
);

export default GhostBar;
