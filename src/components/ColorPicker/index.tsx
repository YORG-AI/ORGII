/**
 * ColorPicker Component
 *
 * A small color-dot button that opens a preset-color popover on click.
 * Closes on outside click or ESC. Reusable across labels, tags, categories, etc.
 *
 * Usage:
 *   <ColorPicker value="#ef4444" onChange={setColor} />
 *   <ColorPicker value={color} onChange={setColor} presets={MY_COLORS} size="lg" />
 */
import React, { memo, useCallback, useEffect, useRef, useState } from "react";

// ============================================
// Default presets
// ============================================

export const DEFAULT_COLOR_PRESETS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#3b82f6",
  "#6366f1",
  "#8b5cf6",
  "#ec4899",
  "#64748b",
] as const;

// ============================================
// Sizes
// ============================================

const SIZE_CLASSES = {
  sm: { dot: "h-4 w-4", preset: "h-4 w-4" },
  md: { dot: "h-5 w-5", preset: "h-5 w-5" },
  lg: { dot: "h-6 w-6", preset: "h-6 w-6" },
} as const;

// ============================================
// Component
// ============================================

interface ColorPickerProps {
  /** Current color value (hex string) */
  value: string;
  /** Called when a color is selected */
  onChange: (color: string) => void;
  /** Preset colors to show (defaults to DEFAULT_COLOR_PRESETS) */
  presets?: readonly string[];
  /** Dot size variant */
  size?: "sm" | "md" | "lg";
  /** Additional className on the wrapper */
  className?: string;
  /** Disabled state */
  disabled?: boolean;
}

const ColorPicker: React.FC<ColorPickerProps> = memo(
  ({
    value,
    onChange,
    presets = DEFAULT_COLOR_PRESETS,
    size = "md",
    className = "",
    disabled = false,
  }) => {
    const [open, setOpen] = useState(false);
    const wrapperRef = useRef<HTMLDivElement>(null);
    const sizeConfig = SIZE_CLASSES[size];

    const handleToggle = useCallback(() => {
      if (!disabled) setOpen((prev) => !prev);
    }, [disabled]);

    const handleSelect = useCallback(
      (color: string) => {
        onChange(color);
        setOpen(false);
      },
      [onChange]
    );

    // Close on outside click
    useEffect(() => {
      if (!open) return;

      const handleClickOutside = (event: MouseEvent) => {
        const target = event.target;
        if (!(target instanceof Node)) return;
        if (wrapperRef.current && !wrapperRef.current.contains(target)) {
          setOpen(false);
        }
      };

      document.addEventListener("mousedown", handleClickOutside);
      return () => {
        document.removeEventListener("mousedown", handleClickOutside);
      };
    }, [open]);

    // Close on ESC
    useEffect(() => {
      if (!open) return;

      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") setOpen(false);
      };

      document.addEventListener("keydown", handleKeyDown);
      return () => {
        document.removeEventListener("keydown", handleKeyDown);
      };
    }, [open]);

    return (
      <div
        ref={wrapperRef}
        className={`relative flex flex-shrink-0 items-center self-center ${className}`}
      >
        <button
          type="button"
          className={`${sizeConfig.dot} block rounded-full leading-none transition-transform hover:scale-110 ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
          style={{ backgroundColor: value }}
          onClick={handleToggle}
          disabled={disabled}
        />
        {open && (
          <div className="absolute left-0 top-[calc(100%+4px)] z-10 flex gap-1 rounded-lg border border-border-2 bg-bg-1 p-2 shadow-lg">
            {presets.map((preset) => (
              <button
                type="button"
                key={preset}
                className={`${sizeConfig.preset} rounded-full transition-transform hover:scale-110 ${preset === value ? "ring-2 ring-primary-5 ring-offset-1" : ""}`}
                style={{ backgroundColor: preset }}
                onClick={() => handleSelect(preset)}
              />
            ))}
          </div>
        )}
      </div>
    );
  }
);

ColorPicker.displayName = "ColorPicker";

export default ColorPicker;
