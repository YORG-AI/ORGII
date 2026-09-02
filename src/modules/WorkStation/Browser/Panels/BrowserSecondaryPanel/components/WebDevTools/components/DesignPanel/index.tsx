/**
 * DesignPanel Component
 *
 * Visual design editor for the selected element.
 * Shows position, layout (flow, size, padding, margin), box model, and effects.
 */
import React, { memo, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";
import {
  EclipseIcon,
  HugeiconsIcon,
  MoreHorizontalIcon,
  SquareRoundCornerIcon,
} from "@src/icons";
import type { FullComputedStyles } from "@src/modules/WorkStation/Browser/hooks/useWebviewStyleEditor";
import {
  EditableField,
  LinkedInputPair,
} from "@src/modules/WorkStation/shared/PropertyEditor";
import { HEADER_BUTTON } from "@src/modules/WorkStation/shared/tokens";

import { CollapsibleSection, SubSection } from "./CollapsibleSection";
import { LayoutButtons } from "./LayoutButtons";

// Corner radius icons for each corner position
const CornerIcon: React.FC<{
  position: "tl" | "tr" | "bl" | "br";
  size?: number;
}> = ({ position, size = 14 }) => {
  const paths: Record<string, string> = {
    tl: "M2 10V5a3 3 0 0 1 3-3h5",
    tr: "M4 2h5a3 3 0 0 1 3 3v5",
    bl: "M2 4v5a3 3 0 0 0 3 3h5",
    br: "M10 12H5a3 3 0 0 1-3-3V4",
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <path d={paths[position]} />
    </svg>
  );
};

// ============================================
// Types
// ============================================

interface DesignPanelProps {
  /** Computed styles for the selected element */
  styles: FullComputedStyles | null;
  /** Callback to change a style property */
  onStyleChange: (property: string, value: string) => void;
  /** Whether style changes are pending */
  isPending?: boolean;
  /** Force all sections to collapse (increments to trigger) */
  collapseAllKey?: number;
  /** Force all sections to expand (increments to trigger) */
  expandAllKey?: number;
}

// Re-export sub-components
export { EditableField };

// ============================================
// Component
// ============================================

export const DesignPanel: React.FC<DesignPanelProps> = memo(
  ({
    styles,
    onStyleChange,
    isPending = false,
    collapseAllKey,
    expandAllKey,
  }) => {
    const { t } = useTranslation();

    // Link state for padding and margin
    const [paddingLinked, setPaddingLinked] = useState(true);
    const [marginLinked, setMarginLinked] = useState(true);
    // Expanded state for border radius (show 4 corners)
    const [radiusExpanded, setRadiusExpanded] = useState(false);

    // Helper to parse numeric value from CSS string
    const parseNumeric = useCallback((value: string | undefined): number => {
      if (!value) return 0;
      const num = parseFloat(value);
      return isNaN(num) ? 0 : Math.round(num);
    }, []);

    // Link toggle button component
    const renderLinkButton = (isLinked: boolean, onToggle: () => void) => (
      <button
        onClick={onToggle}
        className={`${HEADER_BUTTON.action} ${
          isLinked ? "text-text-2" : "text-primary-6"
        }`}
        title={isLinked ? "Unlink values" : "Link values"}
      >
        <HugeiconsIcon
          icon={MoreHorizontalIcon}
          data-icon="ellipsis"
          size={12}
        />
      </button>
    );

    if (!styles) {
      return (
        <Placeholder
          variant="empty"
          title={t("placeholders.noElementSelected")}
        />
      );
    }

    return (
      <div className="scrollbar-hide flex h-full flex-col overflow-y-auto px-3 py-2">
        {/* Position Section */}
        <CollapsibleSection
          title="Position"
          rightContent={styles.position}
          collapseAllKey={collapseAllKey}
          expandAllKey={expandAllKey}
        >
          <div className="grid grid-cols-2 gap-2">
            <EditableField
              label="X"
              value={styles.rect.x}
              unit="px"
              onChange={(value) => onStyleChange("left", value)}
              disabled={isPending}
            />
            <EditableField
              label="Y"
              value={styles.rect.y}
              unit="px"
              onChange={(value) => onStyleChange("top", value)}
              disabled={isPending}
            />
            <EditableField
              label="Z"
              value={styles.zIndex === "auto" ? "auto" : styles.zIndex}
              onChange={(value) => onStyleChange("zIndex", value)}
              disabled={isPending}
            />
          </div>
        </CollapsibleSection>

        {/* Layout Section - Consolidated */}
        <CollapsibleSection
          title="Layout"
          collapseAllKey={collapseAllKey}
          expandAllKey={expandAllKey}
        >
          {/* Flow */}
          <SubSection title="Flow">
            <LayoutButtons
              currentDisplay={styles.display}
              onDisplayChange={(value) => onStyleChange("display", value)}
              disabled={isPending}
            />
          </SubSection>

          {/* Size */}
          <SubSection title="Size">
            <div className="grid grid-cols-2 gap-2">
              <EditableField
                label="W"
                value={styles.rect.width}
                unit="px"
                onChange={(value) => onStyleChange("width", value)}
                disabled={isPending}
              />
              <EditableField
                label="H"
                value={styles.rect.height}
                unit="px"
                onChange={(value) => onStyleChange("height", value)}
                disabled={isPending}
              />
            </div>
          </SubSection>

          {/* Padding */}
          <SubSection
            title="Padding"
            headerActions={renderLinkButton(paddingLinked, () =>
              setPaddingLinked(!paddingLinked)
            )}
          >
            <LinkedInputPair
              topValue={parseNumeric(styles.paddingTop)}
              rightValue={parseNumeric(styles.paddingRight)}
              bottomValue={parseNumeric(styles.paddingBottom)}
              leftValue={parseNumeric(styles.paddingLeft)}
              unit="px"
              isLinked={paddingLinked}
              onTopChange={(value) => onStyleChange("paddingTop", value)}
              onRightChange={(value) => onStyleChange("paddingRight", value)}
              onBottomChange={(value) => onStyleChange("paddingBottom", value)}
              onLeftChange={(value) => onStyleChange("paddingLeft", value)}
              disabled={isPending}
            />
          </SubSection>

          {/* Margin */}
          <SubSection
            title="Margin"
            headerActions={renderLinkButton(marginLinked, () =>
              setMarginLinked(!marginLinked)
            )}
          >
            <LinkedInputPair
              topValue={parseNumeric(styles.marginTop)}
              rightValue={parseNumeric(styles.marginRight)}
              bottomValue={parseNumeric(styles.marginBottom)}
              leftValue={parseNumeric(styles.marginLeft)}
              unit="px"
              isLinked={marginLinked}
              onTopChange={(value) => onStyleChange("marginTop", value)}
              onRightChange={(value) => onStyleChange("marginRight", value)}
              onBottomChange={(value) => onStyleChange("marginBottom", value)}
              onLeftChange={(value) => onStyleChange("marginLeft", value)}
              disabled={isPending}
            />
          </SubSection>
        </CollapsibleSection>

        {/* Appearance Section */}
        <CollapsibleSection
          title="Appearance"
          collapseAllKey={collapseAllKey}
          expandAllKey={expandAllKey}
        >
          <div className="grid grid-cols-2 gap-2">
            {/* Opacity */}
            <SubSection title="Opacity">
              <EditableField
                icon={
                  <HugeiconsIcon
                    icon={EclipseIcon}
                    data-icon="eclipse"
                    size={14}
                  />
                }
                value={Math.round((parseFloat(styles.opacity) || 1) * 100)}
                unit="%"
                onChange={(value) => {
                  const percent = parseFloat(value);
                  if (!isNaN(percent)) {
                    onStyleChange("opacity", String(percent / 100));
                  }
                }}
                min={0}
                max={100}
                step={1}
                disabled={isPending}
              />
            </SubSection>

            {/* Corners */}
            <SubSection
              title="Corners"
              headerActions={
                <button
                  onClick={() => setRadiusExpanded(!radiusExpanded)}
                  className={`${HEADER_BUTTON.action} ${
                    radiusExpanded ? "text-primary-6" : "text-text-2"
                  }`}
                  title={
                    radiusExpanded ? "Use single radius" : "Customize corners"
                  }
                >
                  <HugeiconsIcon
                    icon={MoreHorizontalIcon}
                    data-icon="ellipsis"
                    size={12}
                  />
                </button>
              }
            >
              {radiusExpanded ? (
                <div className="grid grid-cols-2 gap-2">
                  <EditableField
                    icon={<CornerIcon position="tl" size={14} />}
                    value={parseNumeric(styles.borderTopLeftRadius)}
                    unit="px"
                    onChange={(value) =>
                      onStyleChange("borderTopLeftRadius", value)
                    }
                    disabled={isPending}
                  />
                  <EditableField
                    icon={<CornerIcon position="tr" size={14} />}
                    value={parseNumeric(styles.borderTopRightRadius)}
                    unit="px"
                    onChange={(value) =>
                      onStyleChange("borderTopRightRadius", value)
                    }
                    disabled={isPending}
                  />
                  <EditableField
                    icon={<CornerIcon position="bl" size={14} />}
                    value={parseNumeric(styles.borderBottomLeftRadius)}
                    unit="px"
                    onChange={(value) =>
                      onStyleChange("borderBottomLeftRadius", value)
                    }
                    disabled={isPending}
                  />
                  <EditableField
                    icon={<CornerIcon position="br" size={14} />}
                    value={parseNumeric(styles.borderBottomRightRadius)}
                    unit="px"
                    onChange={(value) =>
                      onStyleChange("borderBottomRightRadius", value)
                    }
                    disabled={isPending}
                  />
                </div>
              ) : (
                <EditableField
                  icon={
                    <HugeiconsIcon
                      icon={SquareRoundCornerIcon}
                      data-icon="square-round-corner"
                      size={14}
                    />
                  }
                  value={parseNumeric(styles.borderRadius)}
                  unit="px"
                  onChange={(value) => onStyleChange("borderRadius", value)}
                  disabled={isPending}
                />
              )}
            </SubSection>
          </div>
        </CollapsibleSection>

        {/* Text Section */}
        <CollapsibleSection
          title="Text"
          collapseAllKey={collapseAllKey}
          expandAllKey={expandAllKey}
        >
          <div className="grid grid-cols-3 gap-2">
            <SubSection title="Size">
              <EditableField
                value={parseNumeric(styles.fontSize)}
                unit="px"
                onChange={(value) => onStyleChange("fontSize", value)}
                disabled={isPending}
              />
            </SubSection>
            <SubSection title="Weight">
              <EditableField
                value={styles.fontWeight || "400"}
                onChange={(value) => onStyleChange("fontWeight", value)}
                disabled={isPending}
              />
            </SubSection>
            <SubSection title="Line">
              <EditableField
                value={parseNumeric(styles.lineHeight)}
                unit="px"
                onChange={(value) => onStyleChange("lineHeight", value)}
                disabled={isPending}
              />
            </SubSection>
          </div>
        </CollapsibleSection>

        {/* Border Section */}
        <CollapsibleSection
          title="Border"
          collapseAllKey={collapseAllKey}
          expandAllKey={expandAllKey}
        >
          <div className="grid grid-cols-2 gap-2">
            <SubSection title="Width">
              <EditableField
                value={parseNumeric(styles.borderTopWidth)}
                unit="px"
                onChange={(value) => onStyleChange("borderWidth", value)}
                disabled={isPending}
              />
            </SubSection>
            <SubSection title="Color">
              <EditableField
                value={styles.borderColor || "transparent"}
                onChange={(value) => onStyleChange("borderColor", value)}
                disabled={isPending}
              />
            </SubSection>
          </div>
        </CollapsibleSection>

        {/* Shadow & Blur Section */}
        <CollapsibleSection
          title="Shadow & Blur"
          collapseAllKey={collapseAllKey}
          expandAllKey={expandAllKey}
        >
          <div className="grid grid-cols-2 gap-2">
            <SubSection title="Blur">
              <EditableField
                value={0}
                unit="px"
                onChange={(value) => {
                  const num = parseFloat(value);
                  onStyleChange(
                    "filter",
                    isNaN(num) || num === 0 ? "none" : `blur(${num}px)`
                  );
                }}
                disabled={isPending}
              />
            </SubSection>
            <SubSection title="Spread">
              <EditableField
                value={0}
                unit="px"
                onChange={(value) => {
                  const num = parseFloat(value);
                  onStyleChange(
                    "boxShadow",
                    isNaN(num) || num === 0
                      ? "none"
                      : `0 0 0 ${num}px rgba(0,0,0,0.1)`
                  );
                }}
                disabled={isPending}
              />
            </SubSection>
          </div>
        </CollapsibleSection>
      </div>
    );
  }
);

DesignPanel.displayName = "DesignPanel";

export default DesignPanel;
