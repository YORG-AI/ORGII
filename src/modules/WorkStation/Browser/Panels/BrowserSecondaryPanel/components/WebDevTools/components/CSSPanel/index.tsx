/**
 * CSSPanel Component
 *
 * Shows and allows editing of computed CSS properties.
 * Organized by categories: Typography, Colors, Layout, etc.
 */
import React, { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";
import type { FullComputedStyles } from "@src/modules/WorkStation/Browser/hooks/useWebviewStyleEditor";

import { StyleSection } from "./StyleSection";

// ============================================
// Types
// ============================================

interface CSSPanelProps {
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

// ============================================
// Style Categories
// ============================================

interface StyleCategory {
  name: string;
  properties: Array<{
    key: keyof FullComputedStyles;
    label: string;
  }>;
}

const STYLE_CATEGORIES: StyleCategory[] = [
  {
    name: "Typography",
    properties: [
      { key: "fontSize", label: "font-size" },
      { key: "fontWeight", label: "font-weight" },
      { key: "fontFamily", label: "font-family" },
      { key: "lineHeight", label: "line-height" },
      { key: "letterSpacing", label: "letter-spacing" },
      { key: "textAlign", label: "text-align" },
      { key: "textDecoration", label: "text-decoration" },
      { key: "color", label: "color" },
    ],
  },
  {
    name: "Background",
    properties: [
      { key: "backgroundColor", label: "background-color" },
      { key: "backgroundImage", label: "background-image" },
    ],
  },
  {
    name: "Border",
    properties: [
      { key: "borderRadius", label: "border-radius" },
      { key: "borderStyle", label: "border-style" },
      { key: "borderColor", label: "border-color" },
      { key: "boxShadow", label: "box-shadow" },
    ],
  },
  {
    name: "Layout",
    properties: [
      { key: "display", label: "display" },
      { key: "position", label: "position" },
      { key: "flexDirection", label: "flex-direction" },
      { key: "justifyContent", label: "justify-content" },
      { key: "alignItems", label: "align-items" },
      { key: "flexWrap", label: "flex-wrap" },
      { key: "gap", label: "gap" },
    ],
  },
  {
    name: "Size",
    properties: [
      { key: "width", label: "width" },
      { key: "height", label: "height" },
      { key: "overflow", label: "overflow" },
    ],
  },
  {
    name: "Effects",
    properties: [
      { key: "opacity", label: "opacity" },
      { key: "transform", label: "transform" },
      { key: "transition", label: "transition" },
      { key: "cursor", label: "cursor" },
      { key: "visibility", label: "visibility" },
    ],
  },
];

// ============================================
// Component
// ============================================

export const CSSPanel: React.FC<CSSPanelProps> = memo(
  ({
    styles,
    onStyleChange,
    isPending = false,
    collapseAllKey,
    expandAllKey,
  }) => {
    const { t } = useTranslation();

    // Build style entries for each category
    const categoryData = useMemo(() => {
      if (!styles) return [];

      return STYLE_CATEGORIES.map((category) => ({
        ...category,
        entries: category.properties
          .map((prop) => {
            const value = styles[prop.key];
            // Skip rect which is not a CSS property
            if (prop.key === "rect") return null;
            // Filter out empty or default values
            if (!value || value === "none" || value === "normal") return null;
            return {
              property: prop.label,
              key: prop.key,
              value: String(value),
            };
          })
          .filter(Boolean) as Array<{
          property: string;
          key: string;
          value: string;
        }>,
      })).filter((cat) => cat.entries.length > 0);
    }, [styles]);

    if (!styles) {
      return (
        <Placeholder
          variant="empty"
          placement="detail-panel"
          title={t("placeholders.noElementSelected")}
          fillParentHeight
        />
      );
    }

    if (categoryData.length === 0) {
      return (
        <Placeholder
          variant="empty"
          placement="detail-panel"
          title={t("placeholders.noStyles")}
          fillParentHeight
        />
      );
    }

    return (
      <div className="flex h-full flex-col overflow-y-auto px-3 py-2 scrollbar-hide">
        {categoryData.map((category) => (
          <StyleSection
            key={category.name}
            title={category.name}
            entries={category.entries}
            onValueChange={onStyleChange}
            disabled={isPending}
            collapseAllKey={collapseAllKey}
            expandAllKey={expandAllKey}
          />
        ))}
      </div>
    );
  }
);

CSSPanel.displayName = "CSSPanel";

export default CSSPanel;
