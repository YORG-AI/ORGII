/**
 * Glass Component
 *
 * Implements Apple's macOS material design system with backdrop blur and glass effects.
 * Based on NSVisualEffectView material variations (ultrathin, thin, medium).
 *
 * Features:
 * - Apple-standard material variations (ultrathin, thin, medium, thick)
 * - Theme-aware styling (light/dark mode)
 * - Performance optimized with memoized styles and lazy blur
 * - Intersection Observer for lazy blur (60-70% GPU reduction)
 * - Multi-layer glass structure with specular highlights
 * - Follows Apple Human Interface Guidelines
 */
import React, { forwardRef, useCallback, useMemo } from "react";
import { useInView } from "react-intersection-observer";

import { useEdgeReflection } from "@src/hooks/theme/useEdgeReflection";
import { useGlassMaterial } from "@src/hooks/theme/useGlassMaterial";
import { GlassRegion, LegibilityGuard } from "@src/util/ui/theme/glassMaterial";
import { useCurrentTheme } from "@src/util/ui/theme/themeUtils";

import {
  DEFAULT_MATERIAL,
  MaterialThickness,
  getMaterialConfig,
  getShadowClass,
} from "./config";

// ============================================
// Types
// ============================================

interface GlassProps extends React.HTMLAttributes<HTMLDivElement> {
  children?: React.ReactNode;
  /** Material thickness variation (ultrathin, thin, medium, thick) - follows Apple's design system */
  material?: MaterialThickness;
  /** Border radius in pixels */
  radius?: number;
  /** Disable shadow for flat designs or nested components */
  noShadow?: boolean;
  /** Enable lazy blur - only blur when in viewport (recommended for lists) */
  lazyBlur?: boolean;
  /** Intersection observer threshold (0-1) - when to trigger blur */
  threshold?: number;
  /** Root margin for intersection observer (e.g., "50px") - preload slightly before visible */
  rootMargin?: string;
  /** Enable border (theme-aware) */
  enableBorder?: boolean;
  /** Enable specular highlight (inset top highlight for 3D depth) */
  enableSpecular?: boolean;
  /** Enable Canvas 2D edge reflection (color-reactive rim) - WebKit-friendly */
  enableEdgeReflection?: boolean;
  /** Edge reflection rim width in pixels (default: 3) */
  edgeRimWidth?: number;
  /** Edge reflection brightness multiplier (default: 2.5) */
  edgeBrightness?: number;
  /** Edge reflection sampling frequency in ms (default: 100, 0 = only on mount) */
  edgeSamplingInterval?: number;
  /** Backdrop saturation percentage (default: 100, macOS uses ~180) */
  saturation?: number;
  /** Enable directional lighting effect (default: true) */
  enableLighting?: boolean;
  /** Light angle in degrees (default: -45, from top-left) */
  lightAngle?: number;
  /** Light intensity 0-1 (default: 0.9) */
  lightIntensity?: number;
  /** Depth shadow intensity 0-1 (default: 0.6) */
  depthIntensity?: number;
  /** Enable color-reactive rim from background sampling (image-based) */
  enableRim?: boolean;
  /** Sampled color from background for rim effect */
  rimColor?: { r: number; g: number; b: number } | null;
  /** Skip backdrop-filter (for nested controls inside a parent glass - avoids double-glass stacking) */
  noBackdrop?: boolean;
  /** Rim brightness offset for light layers (default: +70, +100, +60) */
  rimBrightnessOffsets?: { base: number; highlight: number; glow: number };
  /**
   * UI region for automatic material resolution (Apple-style)
   * When set, automatically samples from the appropriate wallpaper region
   * and applies the resolved rim color. Enables enableRim automatically.
   */
  region?: GlassRegion;
  className?: string;
}

// ============================================
// Component
// ============================================

const DEFAULT_RIM_OFFSETS = { base: 70, highlight: 100, glow: 60 } as const;

export const Glass = forwardRef<HTMLDivElement, GlassProps>(
  (incomingProps, ref) => {
    const {
      children,
      material = DEFAULT_MATERIAL,
      radius = 12,
      noShadow = false,
      lazyBlur = false,
      threshold = 0.1,
      rootMargin = "50px",
      enableBorder = false,
      enableSpecular = false,
      enableEdgeReflection = false,
      edgeRimWidth = 3,
      edgeBrightness = 2.5,
      edgeSamplingInterval = 100,
      enableLighting = true,
      lightAngle = -45,
      lightIntensity = 0.9,
      depthIntensity = 0.6,
      enableRim = false,
      rimColor = null,
      noBackdrop = false,
      rimBrightnessOffsets = DEFAULT_RIM_OFFSETS,
      region,
      className = "",
      style,
      ...props
    } = incomingProps;
    const { isDark } = useCurrentTheme();

    // Region-based automatic material resolution (Apple-style)
    // When region is set, automatically resolve material from that wallpaper region
    const { material: resolvedMaterial, isReady: regionMaterialReady } =
      useGlassMaterial(region || "global", {
        thickness: material,
        skip: !region, // Skip if no region specified
      });

    // Determine final rim settings
    // Respect explicit enableRim={false} even when region is set
    // Only auto-enable rim when region is set AND enableRim is not explicitly false
    const finalEnableRim =
      enableRim === false ? false : region ? regionMaterialReady : enableRim;
    const finalRimColor =
      region && resolvedMaterial ? resolvedMaterial.tintRGB : rimColor;
    const finalRimOffsets =
      region && resolvedMaterial
        ? resolvedMaterial.rimOffsets
        : rimBrightnessOffsets;

    // Get material configuration based on theme and material type (MUST be before vibrancy values)
    const materialConfig = useMemo(
      () => getMaterialConfig(isDark, material),
      [isDark, material]
    );

    // Safari vibrancy correction values - from material config (single source of truth)
    // These fight "blur mush" and make glass look crisp
    const vibrancyBrightness = materialConfig.brightness;
    const vibrancyContrast = materialConfig.contrast;
    const vibrancySaturation = materialConfig.saturation * 100; // Convert to percentage

    // Safari-style specular highlight opacity (from resolved material or appearance-based)
    const specularOpacity =
      resolvedMaterial?.highlightOpacity ?? (isDark ? 0.15 : 0.35);

    // Legibility Guard: scrim and foreground adjustments for bright backgrounds
    // This is Safari's "secret sauce" for keeping text readable on any background
    const legibilityGuard: LegibilityGuard | null =
      resolvedMaterial?.legibilityGuard ?? null;

    // Scrim layer: subtle dark overlay on bright backgrounds
    // Only applied when legibility guard is active (L > 0.65)
    const scrimAlpha = legibilityGuard?.scrimAlpha ?? 0;

    // Foreground opacity: text/icons get higher contrast on bright backgrounds
    const foregroundOpacity = legibilityGuard?.foregroundOpacity ?? 1;

    // Pre-compute CSS custom property values to avoid SWC nullish-coalescing codegen bug
    const glassScrimStrength = legibilityGuard?.scrimStrength ?? 0;
    const glassBgLuminance = legibilityGuard?.backgroundLuminance ?? 0.5;

    // Edge reflection hook for Canvas 2D color-reactive rim
    const { containerRef: edgeContainerRef, canvasRef: edgeCanvasRef } =
      useEdgeReflection({
        enabled: enableEdgeReflection,
        radius,
        rimWidth: edgeRimWidth,
        brightness: edgeBrightness,
        samplingInterval: edgeSamplingInterval,
      });

    // Get material-based shadow class
    const shadowClass = useMemo(
      () => (noShadow ? "shadow-none" : getShadowClass(isDark, material)),
      [isDark, material, noShadow]
    );

    // Intersection observer for lazy blur optimization
    // Only applies blur when element is in viewport
    const { ref: inViewRef, inView } = useInView({
      threshold,
      rootMargin,
      triggerOnce: false, // Re-enable blur when scrolling back into view
      skip: !lazyBlur, // Skip observer if lazy blur is disabled
    });

    // Determine if blur should be applied
    // - If noBackdrop is true, never apply backdrop-filter (for nested controls)
    // - If lazyBlur is disabled, always apply blur
    // - If lazyBlur is enabled, only apply when in viewport
    const shouldApplyBlur = !noBackdrop && (!lazyBlur || inView);

    // Theme-aware border color - tinted when region material is available
    const borderColor = useMemo(() => {
      const tint = resolvedMaterial?.tintRGB;
      if (region && tint) {
        // Blend white with tint for a subtle colored border
        const tintStrength = isDark ? 0.25 : 0.35; // Stronger tint for border
        const baseVal = 255; // White base
        const red = Math.round(
          baseVal * (1 - tintStrength) + tint.r * tintStrength
        );
        const green = Math.round(
          baseVal * (1 - tintStrength) + tint.g * tintStrength
        );
        const blue = Math.round(
          baseVal * (1 - tintStrength) + tint.b * tintStrength
        );
        const opacity = isDark ? 0.12 : 0.25;
        return `rgba(${red}, ${green}, ${blue}, ${opacity})`;
      }
      // Fallback to static border
      return isDark ? "rgba(255, 255, 255, 0.06)" : "rgba(255, 255, 255, 0.15)";
    }, [isDark, region, resolvedMaterial?.tintRGB]);

    // Calculate light and shadow gradients based on light angle
    const lightingGradients = useMemo(() => {
      if (!enableLighting) return null;

      // Light gradient (from light source) - more spread out to avoid edge concentration
      const lightGradient = `linear-gradient(${lightAngle}deg, rgba(255, 255, 255, ${lightIntensity * 0.08}) 0%, transparent 70%)`;

      // Depth/shadow gradient (opposite direction for depth) - also spread wider
      const shadowAngle = lightAngle + 180;
      const shadowGradient = `linear-gradient(${shadowAngle}deg, rgba(0, 0, 0, ${depthIntensity * 0.06}) 0%, transparent 70%)`;

      return { lightGradient, shadowGradient };
    }, [enableLighting, lightAngle, lightIntensity, depthIntensity]);

    // Combine refs - intersection observer, forwarded ref, and edge reflection container
    const combinedRef = useCallback(
      (node: HTMLDivElement | null) => {
        // Set the intersection observer ref
        inViewRef(node);

        // Set the edge reflection container ref
        if (edgeContainerRef.current !== node) {
          (
            edgeContainerRef as React.MutableRefObject<HTMLDivElement | null>
          ).current = node;
        }

        // Set the forwarded ref
        if (typeof ref === "function") {
          ref(node);
        } else if (ref) {
          ref.current = node;
        }
      },
      [inViewRef, ref, edgeContainerRef]
    );

    // If advanced effects are enabled, use multi-layer structure
    if (
      enableBorder ||
      enableSpecular ||
      enableEdgeReflection ||
      (finalEnableRim && finalRimColor)
    ) {
      return (
        <div
          ref={combinedRef}
          className={`${shadowClass} ${className}`}
          style={{
            position: "relative",
            borderRadius: `${radius}px`,
            overflow: "hidden",
            ...style,
          }}
          {...props}
        >
          {/* Glass Filter Layer - Safari vibrancy correction
                backdrop-filter: blur() saturate() brightness() contrast()
                This fights "blur mush" and makes glass look crisp */}
          <div
            className="glass-filter"
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: "inherit",
              zIndex: 0,
              pointerEvents: "none",
              backdropFilter: shouldApplyBlur
                ? `blur(${materialConfig.blur}px) saturate(${vibrancySaturation}%) brightness(${vibrancyBrightness}) contrast(${vibrancyContrast})`
                : "none",
              WebkitBackdropFilter: shouldApplyBlur
                ? `blur(${materialConfig.blur}px) saturate(${vibrancySaturation}%) brightness(${vibrancyBrightness}) contrast(${vibrancyContrast})`
                : "none",
            }}
          />

          {/* Glass Overlay Layer - semi-transparent background
                Safari approach: Blend wallpaper tint INTO the base material (not as separate layer)
                This creates a warmer/cooler cast that matches the wallpaper naturally
                
                DYNAMIC OPACITY: Scales based on background luminance
                - Dark bg (low L) → less opacity needed (wallpaper already provides contrast)
                - Bright bg (high L) → more opacity needed (maintain readability) */}
          <div
            className="glass-overlay"
            style={{
              position: "absolute",
              inset: 0,
              borderRadius: "inherit",
              zIndex: 1,
              pointerEvents: "none",
              // Blend tint into base: lerp(baseColor, tintColor, tintStrength)
              // Safari uses ~8-15% tint blending for subtle warmth/coolness
              background:
                region && resolvedMaterial?.tintRGB && !noBackdrop
                  ? (() => {
                      const tint = resolvedMaterial.tintRGB;
                      const tintStrength = isDark ? 0.06 : 0.1; // Light mode gets more visible tint
                      // Base color: white for light, dark gray for dark
                      const baseR = isDark ? 26 : 255;
                      const baseG = isDark ? 26 : 255;
                      const baseB = isDark ? 28 : 255;
                      // Blend base toward tint color
                      const red = Math.round(
                        baseR * (1 - tintStrength) + tint.r * tintStrength
                      );
                      const green = Math.round(
                        baseG * (1 - tintStrength) + tint.g * tintStrength
                      );
                      const blue = Math.round(
                        baseB * (1 - tintStrength) + tint.b * tintStrength
                      );
                      // Extract base opacity from materialConfig.background
                      const opacityMatch =
                        materialConfig.background.match(/[\d.]+\)$/);
                      const _baseOpacity = opacityMatch
                        ? parseFloat(opacityMatch[0])
                        : 0.7;

                      // Dynamic opacity based on background luminance
                      // Uses legibilityGuard.backgroundLuminance (0-1)
                      const bgLuminance =
                        legibilityGuard?.backgroundLuminance ?? 0.5;

                      let finalOpacity: number;
                      if (isDark) {
                        // Dark theme: scale opacity 0.72 (dark bg) to 0.88 (bright bg)
                        // Keeps sidebar always visible, slightly more opaque on bright backgrounds
                        const minOpacity = 0.72;
                        const maxOpacity = 0.88;
                        finalOpacity =
                          minOpacity + bgLuminance * (maxOpacity - minOpacity);
                      } else {
                        // Light theme: scale opacity 0.60 (bright bg) to 0.82 (dark bg)
                        // Bright wallpaper = less opacity ok, dark wallpaper = need more white
                        const minOpacity = 0.6;
                        const maxOpacity = 0.82;
                        finalOpacity =
                          minOpacity +
                          (1 - bgLuminance) * (maxOpacity - minOpacity);
                      }

                      return `rgba(${red}, ${green}, ${blue}, ${finalOpacity.toFixed(2)})`;
                    })()
                  : materialConfig.background,
              border: enableBorder ? `1px solid ${borderColor}` : "none",
            }}
          />

          {/* Wallpaper Tint Layer - VERY subtle color hint from background
                Safari uses minimal tinting (1.5-3%) - the base material dominates
                Tint opacity comes from material config (single source of truth) */}
          {region && resolvedMaterial?.tintRGB && !noBackdrop && (
            <div
              className="glass-tint"
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: "inherit",
                zIndex: 1.2,
                pointerEvents: "none",
                // Tint opacity from material config
                background: `rgba(${resolvedMaterial.tintRGB.r}, ${resolvedMaterial.tintRGB.g}, ${resolvedMaterial.tintRGB.b}, ${materialConfig.tintOpacity})`,
                mixBlendMode: "color", // Only affects hue, not luminance
              }}
            />
          )}

          {/* Legibility Guard: Scrim Layer
                A subtle dark overlay that kicks in on bright backgrounds (L > 0.65)
                This is Safari's approach to keeping glass readable on bright/busy content
                - scrimAlpha ramps from 0 to 0.10 (10% max) based on background luminance
                - Only renders when legibility guard is active */}
          {scrimAlpha > 0 && !noBackdrop && (
            <div
              className="glass-scrim"
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: "inherit",
                zIndex: 1.5,
                pointerEvents: "none",
                background: `rgba(0, 0, 0, ${scrimAlpha})`,
              }}
            />
          )}

          {/* Glass Lighting Layer - directional light and depth */}
          {enableLighting && lightingGradients && (
            <>
              {/* Light source layer */}
              <div
                className="glass-light"
                style={{
                  position: "absolute",
                  inset: 0,
                  borderRadius: "inherit",
                  zIndex: 2,
                  background: lightingGradients.lightGradient,
                  pointerEvents: "none",
                  mixBlendMode: "overlay",
                }}
              />
              {/* Depth shadow layer */}
              <div
                className="glass-depth"
                style={{
                  position: "absolute",
                  inset: 0,
                  borderRadius: "inherit",
                  zIndex: 2.3,
                  background: lightingGradients.shadowGradient,
                  pointerEvents: "none",
                  mixBlendMode: "multiply",
                }}
              />
            </>
          )}

          {/* Glass Specular Layer - Safari "liquid" highlight effect
                This is what makes glass look "liquid" - a TOP-facing gradient
                Light mode: stronger (0.35), Dark mode: subtler (0.15) */}
          {enableSpecular && (
            <div
              className="glass-specular"
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: "inherit",
                zIndex: 2.5,
                // Safari-style: Multi-stop gradient for authentic liquid look
                background: `linear-gradient(
                    to bottom,
                    rgba(255, 255, 255, ${specularOpacity}),
                    rgba(255, 255, 255, ${specularOpacity * 0.3}) 30%,
                    transparent 60%
                  )`,
                pointerEvents: "none",
              }}
            />
          )}

          {/* Image-based Color Rim Layer - uses sampled background colors
                Safari-style: Very thin rim (0.5px) for subtle edge definition */}
          {finalEnableRim && finalRimColor && (
            <div
              className="glass-rim"
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: "inherit",
                zIndex: 2.6,
                boxShadow: `
                    inset 0 0 0 1.5px rgba(${Math.min(255, finalRimColor.r + finalRimOffsets.base)}, ${Math.min(255, finalRimColor.g + finalRimOffsets.base)}, ${Math.min(255, finalRimColor.b + finalRimOffsets.base)}, 0.5),
                    0 0 2px 0 rgba(${Math.min(255, finalRimColor.r + finalRimOffsets.glow)}, ${Math.min(255, finalRimColor.g + finalRimOffsets.glow)}, ${Math.min(255, finalRimColor.b + finalRimOffsets.glow)}, 0.2)
                  `,
                pointerEvents: "none",
              }}
            />
          )}

          {/* Canvas Edge Reflection Layer - color-reactive rim */}
          {enableEdgeReflection && (
            <canvas
              ref={edgeCanvasRef}
              className="glass-edge-reflection"
              style={{
                position: "absolute",
                inset: 0,
                borderRadius: "inherit",
                zIndex: 2.5,
                pointerEvents: "none",
                mixBlendMode: "screen", // Blend mode for bright rim effect
              }}
            />
          )}

          {/* Content wrapper - positioned above glass layers, inherits parent layout
                Exposes CSS custom properties for foreground (text/icon) opacity:
                - --glass-foreground-opacity: 0.85-1.0 based on background brightness
                - --glass-scrim-strength: 0-1 (how active the legibility guard is)
                Child components can use these to adjust their contrast on bright backgrounds */}
          <div
            className="glass-content"
            style={
              {
                position: "relative",
                zIndex: 10,
                display: "inherit",
                flexDirection: "inherit",
                alignItems: "inherit",
                justifyContent: "inherit",
                gap: "inherit",
                flex: "inherit",
                width: "100%",
                height: "100%",
                // CSS custom properties for foreground guard
                "--glass-foreground-opacity": foregroundOpacity,
                "--glass-scrim-strength": glassScrimStrength,
                "--glass-bg-luminance": glassBgLuminance,
              } as React.CSSProperties
            }
          >
            {children}
          </div>
        </div>
      );
    }

    // Simple single-layer structure (with Safari vibrancy correction)
    // Also includes CSS custom properties for foreground guard
    return (
      <div
        ref={combinedRef}
        style={
          {
            backdropFilter: shouldApplyBlur
              ? `blur(${materialConfig.blur}px) saturate(${vibrancySaturation}%) brightness(${vibrancyBrightness}) contrast(${vibrancyContrast})`
              : "none",
            WebkitBackdropFilter: shouldApplyBlur
              ? `blur(${materialConfig.blur}px) saturate(${vibrancySaturation}%) brightness(${vibrancyBrightness}) contrast(${vibrancyContrast})`
              : "none",
            background: materialConfig.background,
            borderRadius: radius,
            border: "none",
            overflow: "hidden",
            willChange: shouldApplyBlur
              ? "backdrop-filter, opacity"
              : undefined,
            contain: "layout style paint",
            "--glass-foreground-opacity": foregroundOpacity,
            "--glass-scrim-strength": glassScrimStrength,
            "--glass-bg-luminance": glassBgLuminance,
            ...style,
          } as React.CSSProperties
        }
        className={`${shadowClass} ${className}`}
        {...props}
      >
        {children}
      </div>
    );
  }
);

Glass.displayName = "Glass";

export default Glass;

// Re-export config utilities for convenience
export { getMaterialConfig } from "./config";
