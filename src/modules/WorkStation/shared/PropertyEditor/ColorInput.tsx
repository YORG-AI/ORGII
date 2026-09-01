/**
 * ColorInput Component
 *
 * Color picker with hex input field.
 * Used for fill and stroke color editing.
 */
import React, { memo, useCallback, useState } from "react";

// ============================================
// Types
// ============================================

export interface ColorInputProps {
  /** Current color value (hex) */
  value: string;
  /** Change handler */
  onChange: (value: string) => void;
  /** Whether the input is disabled */
  disabled?: boolean;
  /** Show opacity input */
  showOpacity?: boolean;
  /** Opacity value (0-1) */
  opacity?: number;
  /** Opacity change handler */
  onOpacityChange?: (value: number) => void;
}

// ============================================
// Component
// ============================================

export const ColorInput: React.FC<ColorInputProps> = memo(
  ({
    value,
    onChange,
    disabled = false,
    showOpacity = false,
    opacity = 1,
    onOpacityChange,
  }) => {
    const [editingHex, setEditingHex] = useState<string | null>(null);

    const handleColorPickerChange = useCallback(
      (event: React.ChangeEvent<HTMLInputElement>) => {
        onChange(event.target.value);
      },
      [onChange]
    );

    const handleHexChange = useCallback(
      (event: React.ChangeEvent<HTMLInputElement>) => {
        setEditingHex(event.target.value);
      },
      []
    );

    const handleHexBlur = useCallback(() => {
      if (editingHex === null) return;

      // Validate and normalize hex
      let hex = editingHex.trim();
      if (!hex.startsWith("#")) {
        hex = "#" + hex;
      }

      // Validate hex format
      if (/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(hex)) {
        // Expand shorthand (#RGB -> #RRGGBB)
        if (hex.length === 4) {
          hex = `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
        }
        onChange(hex);
      }

      setEditingHex(null);
    }, [editingHex, onChange]);

    const handleHexFocus = useCallback(() => {
      setEditingHex(value);
    }, [value]);

    const handleHexKeyDown = useCallback(
      (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter") {
          (event.target as HTMLInputElement).blur();
        } else if (event.key === "Escape") {
          setEditingHex(null);
          (event.target as HTMLInputElement).blur();
        }
      },
      []
    );

    const handleOpacityChange = useCallback(
      (event: React.ChangeEvent<HTMLInputElement>) => {
        const percent = parseInt(event.target.value) || 0;
        onOpacityChange?.(Math.max(0, Math.min(100, percent)) / 100);
      },
      [onOpacityChange]
    );

    const displayHex = editingHex !== null ? editingHex : value || "#000000";

    return (
      <div className="flex items-center gap-2">
        {/* Color picker swatch */}
        <div className="relative h-6 w-6 shrink-0 overflow-hidden rounded border border-border-2">
          <input
            type="color"
            value={value || "#000000"}
            onChange={handleColorPickerChange}
            disabled={disabled}
            className="absolute -top-1 -left-1 h-8 w-8 cursor-pointer border-none bg-transparent"
          />
        </div>

        {/* Hex input */}
        <input
          type="text"
          value={displayHex}
          onChange={handleHexChange}
          onBlur={handleHexBlur}
          onFocus={handleHexFocus}
          onKeyDown={handleHexKeyDown}
          disabled={disabled}
          placeholder="#000000"
          className="h-6 flex-1 rounded border border-border-2 bg-pane-input px-2 text-[11px] text-text-1 outline-none focus:border-primary-6 disabled:opacity-50"
        />

        {/* Opacity input */}
        {showOpacity && (
          <div className="flex items-center gap-1">
            <input
              type="number"
              value={Math.round(opacity * 100)}
              onChange={handleOpacityChange}
              disabled={disabled}
              min={0}
              max={100}
              className="h-6 w-12 rounded border border-border-2 bg-pane-input px-1 text-center text-[11px] text-text-1 outline-none focus:border-primary-6 disabled:opacity-50"
            />
            <span className="text-[10px] text-text-3">%</span>
          </div>
        )}
      </div>
    );
  }
);

ColorInput.displayName = "ColorInput";

export default ColorInput;
