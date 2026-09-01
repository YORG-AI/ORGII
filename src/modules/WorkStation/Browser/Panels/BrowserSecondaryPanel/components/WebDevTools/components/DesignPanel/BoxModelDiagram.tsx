/**
 * BoxModelDiagram Component
 *
 * Visual representation of the CSS box model.
 * Shows margin, border, padding, and content areas with editable values.
 */
import React, { memo, useCallback } from "react";

// ============================================
// Types
// ============================================

interface BoxValues {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface BoxModelDiagramProps {
  /** Margin values */
  margin: BoxValues;
  /** Padding values */
  padding: BoxValues;
  /** Border widths */
  border: BoxValues;
  /** Content width */
  contentWidth: number;
  /** Content height */
  contentHeight: number;
  /** Handler for margin changes */
  onMarginChange?: (side: string, value: string) => void;
  /** Handler for padding changes */
  onPaddingChange?: (side: string, value: string) => void;
  /** Whether editing is disabled */
  disabled?: boolean;
}

// ============================================
// Helper Component
// ============================================

interface BoxValueDisplayProps {
  value: number;
  position: "top" | "right" | "bottom" | "left";
  onClick?: () => void;
}

const BoxValueDisplay: React.FC<BoxValueDisplayProps> = memo(
  ({ value, position, onClick }) => {
    const positionClasses = {
      top: "top-0.5 left-1/2 -translate-x-1/2",
      right: "right-0.5 top-1/2 -translate-y-1/2",
      bottom: "bottom-0.5 left-1/2 -translate-x-1/2",
      left: "left-0.5 top-1/2 -translate-y-1/2",
    };

    return (
      <span
        className={`absolute text-[8px] text-text-3 ${positionClasses[position]} ${
          onClick ? "cursor-pointer hover:text-text-1" : ""
        }`}
        onClick={onClick}
      >
        {value || "-"}
      </span>
    );
  }
);

BoxValueDisplay.displayName = "BoxValueDisplay";

// ============================================
// Component
// ============================================

export const BoxModelDiagram: React.FC<BoxModelDiagramProps> = memo(
  ({
    margin,
    padding,
    border: _border,
    contentWidth,
    contentHeight,
    onMarginChange,
    onPaddingChange,
    disabled = false,
  }) => {
    const handleMarginClick = useCallback(
      (_side: string) => {
        if (disabled || !onMarginChange) return;
        // Could open a popover or inline edit - placeholder for future implementation
      },
      [disabled, onMarginChange]
    );

    const handlePaddingClick = useCallback(
      (_side: string) => {
        if (disabled || !onPaddingChange) return;
        // Placeholder for future implementation
      },
      [disabled, onPaddingChange]
    );

    return (
      <div className="flex items-center justify-center rounded bg-bg-3 p-2">
        {/* Margin box */}
        <div className="relative flex items-center justify-center rounded border border-dashed border-warning-6/50 bg-warning-6/5 p-3">
          {/* Margin label */}
          <span className="absolute -top-2 left-1 rounded bg-bg-3 px-1 text-[8px] text-warning-6 uppercase">
            margin
          </span>

          {/* Margin values */}
          <BoxValueDisplay
            value={margin.top}
            position="top"
            onClick={() => handleMarginClick("Top")}
          />
          <BoxValueDisplay
            value={margin.right}
            position="right"
            onClick={() => handleMarginClick("Right")}
          />
          <BoxValueDisplay
            value={margin.bottom}
            position="bottom"
            onClick={() => handleMarginClick("Bottom")}
          />
          <BoxValueDisplay
            value={margin.left}
            position="left"
            onClick={() => handleMarginClick("Left")}
          />

          {/* Padding box */}
          <div className="relative flex items-center justify-center rounded border border-dashed border-success-6/50 bg-success-6/5 p-3">
            {/* Padding label */}
            <span className="absolute -top-2 left-1 rounded bg-warning-6/5 px-1 text-[8px] text-success-6 uppercase">
              padding
            </span>

            {/* Padding values */}
            <BoxValueDisplay
              value={padding.top}
              position="top"
              onClick={() => handlePaddingClick("Top")}
            />
            <BoxValueDisplay
              value={padding.right}
              position="right"
              onClick={() => handlePaddingClick("Right")}
            />
            <BoxValueDisplay
              value={padding.bottom}
              position="bottom"
              onClick={() => handlePaddingClick("Bottom")}
            />
            <BoxValueDisplay
              value={padding.left}
              position="left"
              onClick={() => handlePaddingClick("Left")}
            />

            {/* Content box */}
            <div className="flex min-h-[40px] min-w-[60px] items-center justify-center rounded bg-primary-6/20 px-3 py-1">
              <span className="text-[9px] text-primary-6">
                {contentWidth} × {contentHeight}
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  }
);

BoxModelDiagram.displayName = "BoxModelDiagram";

export default BoxModelDiagram;
