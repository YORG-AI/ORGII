/**
 * TokenOverridePanel
 *
 * A Figma-like floating panel for adjusting token values.
 * Features:
 * - Draggable position
 * - Collapsible
 * - Positioned in bottom-right corner by default
 */
import React, { useCallback, useRef, useState } from "react";

import Select from "@src/components/Select";
import {
  Add01Icon,
  Cancel01Icon,
  ColorPickerIcon,
  GripVerticalIcon,
  HugeiconsIcon,
  MinusSignIcon,
} from "@src/icons";

// ============================================
// Token Presets (moved from SingleEventPreview)
// ============================================

export const FONT_SIZE_PRESETS = [
  { key: "default", label: "Default (13px)", value: null },
  { key: "compact", label: "Compact (11px)", value: "11px" },
  { key: "small", label: "Small (12px)", value: "12px" },
  { key: "normal", label: "Normal (13px)", value: "13px" },
  { key: "medium", label: "Medium (14px)", value: "14px" },
  { key: "large", label: "Large (15px)", value: "15px" },
  { key: "xlarge", label: "X-Large (16px)", value: "16px" },
] as const;

// Color presets removed - not needed for token preview

export const SPACING_PRESETS = [
  { key: "default", label: "Default (12px / 8px)", padding: null, gap: null },
  { key: "compact", label: "Compact (8px / 4px)", padding: "8px", gap: "4px" },
  {
    key: "comfortable",
    label: "Comfortable (16px / 12px)",
    padding: "16px",
    gap: "12px",
  },
  {
    key: "spacious",
    label: "Spacious (24px / 16px)",
    padding: "24px",
    gap: "16px",
  },
] as const;

export const RADIUS_PRESETS = [
  { key: "default", label: "Default (8px)", value: null },
  { key: "none", label: "Sharp (0)", value: "0" },
  { key: "small", label: "Small (4px)", value: "4px" },
  { key: "medium", label: "Medium (8px)", value: "8px" },
  { key: "large", label: "Large (12px)", value: "12px" },
  { key: "pill", label: "Pill (999px)", value: "999px" },
] as const;

// ============================================
// Types
// ============================================

export interface TokenOverrides {
  fontSize: string | null;
  padding: string | null;
  gap: string | null;
  borderRadius: string | null;
}

interface TokenOverridePanelProps {
  isOpen: boolean;
  onClose: () => void;
  fontSizePreset: string;
  spacingPreset: string;
  radiusPreset: string;
  onFontSizeChange: (value: string) => void;
  onSpacingChange: (value: string) => void;
  onRadiusChange: (value: string) => void;
  onReset: () => void;
}

// ============================================
// Component
// ============================================

const PANEL_WIDTH = 280;

export function TokenOverridePanel({
  isOpen,
  onClose,
  fontSizePreset,
  spacingPreset,
  radiusPreset,
  onFontSizeChange,
  onSpacingChange,
  onRadiusChange,
  onReset,
}: TokenOverridePanelProps) {
  const [isMinimized, setIsMinimized] = useState(false);
  const [position, setPosition] = useState({ right: 16, top: 60 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0, right: 0, top: 0 });
  const panelRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsDragging(true);
      dragStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        right: position.right,
        top: position.top,
      };

      const handleMouseMove = (moveEvent: MouseEvent) => {
        const deltaX = moveEvent.clientX - dragStartRef.current.x;
        const deltaY = moveEvent.clientY - dragStartRef.current.y;
        const newRight = Math.max(0, dragStartRef.current.right - deltaX);
        const newTop = Math.max(0, dragStartRef.current.top + deltaY);
        setPosition({ right: newRight, top: newTop });
      };

      const handleMouseUp = () => {
        setIsDragging(false);
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [position]
  );

  const hasOverrides =
    fontSizePreset !== "default" ||
    spacingPreset !== "default" ||
    radiusPreset !== "default";

  if (!isOpen) return null;

  return (
    <div
      ref={panelRef}
      className="absolute z-50 flex flex-col overflow-hidden rounded-xl border border-border-2 bg-bg-1 shadow-xl"
      style={{
        right: position.right,
        top: position.top,
        width: isMinimized ? "auto" : PANEL_WIDTH,
        cursor: isDragging ? "grabbing" : "default",
      }}
    >
      {/* Header - draggable */}
      <div
        className="flex items-center justify-between border-b border-border-2 bg-bg-2 px-3 py-2"
        onMouseDown={handleMouseDown}
        style={{ cursor: isDragging ? "grabbing" : "grab" }}
      >
        <div className="flex items-center gap-2">
          <HugeiconsIcon
            icon={GripVerticalIcon}
            data-icon="grip-vertical"
            size={14}
            className="text-text-3"
          />
          <HugeiconsIcon
            icon={ColorPickerIcon}
            data-icon="palette"
            size={14}
            className="text-primary-6"
          />
          <span className="text-[12px] font-medium text-text-1">
            Token Override
          </span>
          {hasOverrides && (
            <span className="h-1.5 w-1.5 rounded-full bg-primary-6" />
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            className="flex h-5 w-5 items-center justify-center rounded text-text-3 hover:bg-fill-2 hover:text-text-1"
            onClick={() => setIsMinimized(!isMinimized)}
            title={isMinimized ? "Expand" : "Minimize"}
          >
            {isMinimized ? (
              <HugeiconsIcon icon={Add01Icon} data-icon="plus" size={12} />
            ) : (
              <HugeiconsIcon icon={MinusSignIcon} data-icon="minus" size={12} />
            )}
          </button>
          <button
            className="flex h-5 w-5 items-center justify-center rounded text-text-3 hover:bg-fill-2 hover:text-text-1"
            onClick={onClose}
            title="Close"
          >
            <HugeiconsIcon icon={Cancel01Icon} data-icon="x" size={12} />
          </button>
        </div>
      </div>

      {/* Content */}
      {!isMinimized && (
        <div className="flex flex-col gap-3 p-3">
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-medium text-text-3">
              Font Size
            </label>
            <Select
              value={fontSizePreset}
              options={FONT_SIZE_PRESETS.map((p) => ({
                value: p.key,
                label: p.label,
              }))}
              onChange={(val) => onFontSizeChange(String(val))}
              size="small"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-medium text-text-3">
              Spacing
            </label>
            <Select
              value={spacingPreset}
              options={SPACING_PRESETS.map((p) => ({
                value: p.key,
                label: p.label,
              }))}
              onChange={(val) => onSpacingChange(String(val))}
              size="small"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-medium text-text-3">
              Radius
            </label>
            <Select
              value={radiusPreset}
              options={RADIUS_PRESETS.map((p) => ({
                value: p.key,
                label: p.label,
              }))}
              onChange={(val) => onRadiusChange(String(val))}
              size="small"
            />
          </div>

          {hasOverrides && (
            <button
              className="mt-1 w-full rounded-md bg-fill-3 px-3 py-1.5 text-[12px] font-medium text-text-2 transition-colors hover:bg-fill-4 hover:text-text-1"
              onClick={onReset}
            >
              Reset All
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================
// Helper Functions
// ============================================

export function computeTokenOverrides(
  fontSizePreset: string,
  spacingPreset: string,
  radiusPreset: string
): TokenOverrides {
  const fontSize =
    FONT_SIZE_PRESETS.find((p) => p.key === fontSizePreset)?.value ?? null;
  const spacingConfig = SPACING_PRESETS.find((p) => p.key === spacingPreset);
  const radius =
    RADIUS_PRESETS.find((p) => p.key === radiusPreset)?.value ?? null;

  return {
    fontSize,
    padding: spacingConfig?.padding ?? null,
    gap: spacingConfig?.gap ?? null,
    borderRadius: radius,
  };
}

export function generateOverrideStyles(
  overrides: TokenOverrides
): React.CSSProperties {
  const styles: Record<string, string> = {};

  if (overrides.fontSize) {
    styles["--token-font-size"] = overrides.fontSize;
  }
  if (overrides.padding) {
    styles["--token-padding"] = overrides.padding;
  }
  if (overrides.gap) {
    styles["--token-gap"] = overrides.gap;
  }
  if (overrides.borderRadius) {
    styles["--token-border-radius"] = overrides.borderRadius;
  }

  return styles as React.CSSProperties;
}

export function getOverrideClassName(overrides: TokenOverrides): string {
  const classes: string[] = ["token-override-container"];

  if (overrides.fontSize) classes.push("token-override-font");
  if (overrides.padding || overrides.gap)
    classes.push("token-override-spacing");
  if (overrides.borderRadius) classes.push("token-override-radius");

  return classes.join(" ");
}
