/**
 * Miniature preview of a skin: its surface, accent, and ink, in that reading
 * order. Three overlapping dots carry more information per pixel than a single
 * color chip — surface tells you how dark the app will be, accent tells you
 * what the buttons will look like, and ink confirms the pair is legible.
 */
import React from "react";

import { getSkinSeed } from "@src/config/appearance/skins/registry";
import type { SkinVariant } from "@src/config/appearance/skins/types";

interface SkinSwatchProps {
  skinId: string;
  variant: SkinVariant;
  /** Diameter of a single dot, in pixels. */
  size?: number;
}

export const SkinSwatch: React.FC<SkinSwatchProps> = ({
  skinId,
  variant,
  size = 12,
}) => {
  const seed = getSkinSeed(skinId, variant);
  const dots = [seed.surface, seed.accent, seed.ink];

  return (
    // Overlap comes from each dot's negative margin, not from `gap` — a
    // negative gap is invalid CSS and silently does nothing.
    <span aria-hidden className="inline-flex shrink-0 items-center">
      {dots.map((color, index) => (
        <span
          key={color + String(index)}
          className="rounded-full"
          style={{
            width: size,
            height: size,
            backgroundColor: color,
            // Without an outline a surface dot vanishes into a matching panel.
            boxShadow: "inset 0 0 0 1px var(--color-border-3)",
            marginLeft: index === 0 ? 0 : -Math.round(size / 3),
            zIndex: dots.length - index,
          }}
        />
      ))}
    </span>
  );
};

interface AccentSwatchProps {
  color: string;
  size?: number;
}

export const AccentSwatch: React.FC<AccentSwatchProps> = ({
  color,
  size = 12,
}) => (
  <span
    aria-hidden
    className="inline-block shrink-0 rounded-full"
    style={{
      width: size,
      height: size,
      backgroundColor: color,
      boxShadow: "inset 0 0 0 1px var(--color-border-3)",
    }}
  />
);

export default SkinSwatch;
