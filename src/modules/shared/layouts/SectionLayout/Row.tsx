/**
 * SectionRow Component
 *
 * Reusable row with consistent left/right layout.
 * - Left: label/title
 * - Right: controls (radio, input, etc.)
 *
 * Horizontal padding is provided by the parent SectionContainer.
 */
import React, { memo } from "react";

import {
  SECTION_DESCRIPTION_CLASSES,
  SECTION_DESCRIPTION_COMPACT_CLASSES,
  SECTION_INDENT_CLASSES,
  SECTION_LABEL_CLASSES,
  SECTION_LABEL_COMPACT_CLASSES,
  SECTION_LABEL_LIGHT_CLASSES,
} from "./tokens";

export interface SectionRowProps {
  /** Row label (left side). Omit to render content-only (no header). */
  label?: React.ReactNode;
  /** Optional description under label */
  description?: string;
  /** Control element (right side). Omit for label-only rows. */
  children?: React.ReactNode;
  /** Layout: 'horizontal' (default) or 'vertical' for full-width content */
  layout?: "horizontal" | "vertical";
  /** Use lighter font weight for label (legacy alias — default labels are already normal weight) */
  light?: boolean;
  /** Indent row for sub-settings (applies SECTION_INDENT_CLASSES) */
  indent?: boolean;
  /** Hide label/description header and render content-only indented block */
  showHeader?: boolean;
  /** Show red asterisk after label to indicate required field */
  required?: boolean;
  /** Compact mode: 12px text, tighter padding — matches InfoRow density */
  compact?: boolean;
  /** Horizontal layout alignment once the row switches from stacked to side-by-side. */
  align?: "center" | "start";
  /** Left label vertical alignment inside the label cell. Defaults to matching `align`. */
  labelAlign?: "center" | "start";
  headerClassName?: string;
  /** Keep label on one line and truncate with ellipsis when space is tight. */
  truncateLabel?: boolean;
  /** Extra classes on the row wrapper (e.g. to override vertical padding). */
  className?: string;
}

const RequiredMark: React.FC = () => (
  <span className="ml-0.5 text-danger-6">*</span>
);

const SectionRow: React.FC<SectionRowProps> = memo(
  ({
    label,
    description,
    children,
    layout = "horizontal",
    light = false,
    indent = false,
    showHeader = true,
    required = false,
    compact = false,
    align = "center",
    labelAlign,
    headerClassName = "",
    truncateLabel = false,
    className = "",
  }) => {
    const labelClass = compact
      ? SECTION_LABEL_COMPACT_CLASSES
      : light
        ? SECTION_LABEL_LIGHT_CLASSES
        : SECTION_LABEL_CLASSES;

    const descClass = compact
      ? SECTION_DESCRIPTION_COMPACT_CLASSES
      : SECTION_DESCRIPTION_CLASSES;

    const pyClass = compact ? "py-1.5" : "py-3";
    const gapClass = compact ? "gap-1" : "gap-2";
    const minHeightClass = compact ? "" : "min-h-[52px]";

    const indentClass = indent ? SECTION_INDENT_CLASSES : "";

    const labelContent = (
      <>
        {label}
        {required && <RequiredMark />}
      </>
    );

    if (!showHeader || label == null) {
      return (
        <div
          className={`section-layout-row relative ${minHeightClass} ${pyClass} ${indentClass} ${className}`}
        >
          {children}
        </div>
      );
    }

    if (layout === "vertical") {
      return (
        <div
          className={`section-layout-row relative flex flex-col ${gapClass} ${minHeightClass} ${pyClass} ${indentClass} ${className}`}
        >
          {/* Header: Label */}
          <div>
            <div className={`${labelClass} ${truncateLabel ? "truncate" : ""}`}>
              {labelContent}
            </div>
            {description && <div className={descClass}>{description}</div>}
          </div>

          {/* Content: Full width */}
          <div>{children}</div>
        </div>
      );
    }

    const alignClass =
      align === "start" ? "@[480px]:items-start" : "@[480px]:items-center";
    const resolvedLabelAlign = labelAlign ?? align;
    const labelAlignClass =
      resolvedLabelAlign === "start" ? "items-start" : "items-center";

    return (
      <div
        className={`section-layout-row relative flex flex-col ${gapClass} ${minHeightClass} ${pyClass} @[480px]:flex-row ${alignClass} @[480px]:justify-between @[480px]:gap-4 ${indentClass} ${className}`}
      >
        {/* Label + Description */}
        <div
          className={`flex min-w-0 flex-1 ${labelAlignClass} gap-2 ${headerClassName}`}
        >
          <div className="min-w-0">
            <div className={`${labelClass} ${truncateLabel ? "truncate" : ""}`}>
              {labelContent}
            </div>
            {description && <div className={descClass}>{description}</div>}
          </div>
        </div>

        {/* Controls — below label when narrow, beside when wide. min-w-0 allows path truncation. */}
        <div className="flex min-w-0 max-w-full items-center">{children}</div>
      </div>
    );
  }
);

SectionRow.displayName = "SectionRow";

export default SectionRow;
