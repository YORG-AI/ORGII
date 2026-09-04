/**
 * EditableStyleRow Component
 *
 * A single CSS property row with editable value.
 * Shows property name on left, value on right.
 */
import React, { memo, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Input from "@src/components/Input";
import { ToolbarTooltip } from "@src/components/KeyboardShortcut/ToolbarTooltip";
import { Copy01Icon, HugeiconsIcon, Tick01Icon } from "@src/icons";
import { copyText } from "@src/util/data/clipboard";

// ============================================
// Types
// ============================================

export interface EditableStyleRowProps {
  /** CSS property name (display, e.g., "font-size") */
  property: string;
  /** Property key (for API, e.g., "fontSize") */
  propertyKey: string;
  /** Current value */
  value: string;
  /** Change handler */
  onChange: (property: string, value: string) => void;
  /** Whether editing is disabled */
  disabled?: boolean;
}

// ============================================
// Component
// ============================================

export const EditableStyleRow: React.FC<EditableStyleRowProps> = memo(
  ({ property, propertyKey, value, onChange, disabled = false }) => {
    const { t } = useTranslation();
    const [editingValue, setEditingValue] = useState<string | null>(null);
    const [copied, setCopied] = useState(false);

    const isEditing = editingValue !== null;

    const handleDoubleClick = useCallback(() => {
      if (!disabled) {
        setEditingValue(value);
      }
    }, [disabled, value]);

    const handleInputChange = useCallback((newValue: string) => {
      setEditingValue(newValue);
    }, []);

    const handleBlur = useCallback(() => {
      if (editingValue !== null && editingValue !== value) {
        onChange(propertyKey, editingValue);
      }
      setEditingValue(null);
    }, [editingValue, value, propertyKey, onChange]);

    const handleKeyDown = useCallback(
      (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          setEditingValue(null);
        }
      },
      []
    );

    const handleCopy = useCallback(() => {
      void copyText(`${property}: ${value};`).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      });
    }, [property, value]);

    // Truncate long values for display
    const displayValue =
      value.length > 30 ? value.substring(0, 27) + "..." : value;

    // Check if value is a color
    const isColor =
      value.startsWith("#") ||
      value.startsWith("rgb") ||
      value.startsWith("hsl");

    return (
      <div className="group flex items-center gap-2 px-3 py-1 hover:bg-fill-1">
        {/* Property name */}
        <span className="w-28 shrink-0 truncate text-[11px] text-text-3">
          {property}
        </span>

        {/* Color swatch if applicable */}
        {isColor && (
          <div
            className="h-3 w-3 shrink-0 rounded border border-border-2"
            style={{ backgroundColor: value }}
            title={value}
          />
        )}

        {/* Value */}
        {isEditing ? (
          <Input
            size="mini"
            value={editingValue}
            onChange={handleInputChange}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            autoFocus
            className="style-row-input input-pane-surface min-w-0 flex-1"
          />
        ) : (
          <span
            className={`min-w-0 flex-1 truncate text-[11px] ${
              disabled ? "text-text-3" : "cursor-text text-text-2"
            }`}
            title={value}
            onDoubleClick={handleDoubleClick}
          >
            {displayValue}
          </span>
        )}

        {/* Copy button */}
        <ToolbarTooltip label={t("tooltips.copy")}>
          <Button
            variant="tertiary"
            size="mini"
            icon={
              copied ? (
                <HugeiconsIcon
                  icon={Tick01Icon}
                  data-icon="check"
                  size={10}
                  className="text-success-6"
                />
              ) : (
                <HugeiconsIcon
                  icon={Copy01Icon}
                  data-icon="copy"
                  size={10}
                  className="text-text-3"
                />
              )
            }
            iconOnly
            onClick={handleCopy}
            aria-label={t("tooltips.copy")}
            className="shrink-0 opacity-0 group-hover:opacity-100"
          />
        </ToolbarTooltip>
      </div>
    );
  }
);

EditableStyleRow.displayName = "EditableStyleRow";

export default EditableStyleRow;
