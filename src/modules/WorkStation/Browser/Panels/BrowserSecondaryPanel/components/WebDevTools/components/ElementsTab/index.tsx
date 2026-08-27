/**
 * ElementsTab Component
 *
 * Displays selected element details with copy functionality.
 */
import { Check, Copy, X } from "lucide-react";
import React, { memo, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { ToolbarTooltip } from "@src/components/KeyboardShortcut/ToolbarTooltip";
import { Placeholder } from "@src/components/Placeholder";
import type { ElementInfo } from "@src/modules/WorkStation/Browser/hooks/useWebviewInspector";
import { copyText } from "@src/util/data/clipboard";

// ============================================
// Types
// ============================================

export interface ElementsTabProps {
  element: ElementInfo | null;
  onClear?: () => void;
}

// ============================================
// Component
// ============================================

export const ElementsTab: React.FC<ElementsTabProps> = memo(
  ({ element, onClear }) => {
    const { t } = useTranslation();
    const [copiedField, setCopiedField] = useState<string | null>(null);

    const handleCopy = useCallback((text: string, field: string) => {
      void copyText(text).then(() => {
        setCopiedField(field);
        setTimeout(() => setCopiedField(null), 1500);
      });
    }, []);

    if (!element) {
      return (
        <Placeholder
          variant="empty"
          placement="detail-panel"
          title={t("placeholders.noElementSelected")}
          fillParentHeight
        />
      );
    }

    const renderCopyButton = (text: string, field: string) => (
      <ToolbarTooltip label={t("tooltips.copy")}>
        <Button
          variant="tertiary"
          size="mini"
          icon={
            copiedField === field ? (
              <Check size={10} className="text-success-6" />
            ) : (
              <Copy size={10} />
            )
          }
          iconOnly
          onClick={() => handleCopy(text, field)}
          aria-label={t("tooltips.copy")}
          className="ml-1"
        />
      </ToolbarTooltip>
    );

    return (
      <div className="flex h-full flex-col overflow-hidden">
        {/* Header with clear button */}
        <div className="flex shrink-0 items-center justify-between border-b border-border-1 bg-workstation-bg px-3 py-1.5">
          <span className="text-[11px] font-medium text-text-1">
            {element.selector}
          </span>
          {onClear && (
            <ToolbarTooltip label={t("tooltips.clearSelection")}>
              <Button
                variant="tertiary"
                size="mini"
                icon={<X size={12} />}
                iconOnly
                onClick={onClear}
                aria-label={t("tooltips.clearSelection")}
              />
            </ToolbarTooltip>
          )}
        </div>

        {/* Element details */}
        <div className="flex-1 overflow-y-auto p-2">
          {/* Dimensions */}
          <div className="mb-3">
            <div className="mb-1 text-[10px] font-medium uppercase text-text-3">
              Dimensions
            </div>
            <div className="rounded bg-bg-3 px-3 py-1.5 text-[11px]">
              <span className="text-text-2">
                {element.rect.width} × {element.rect.height}
              </span>
              <span className="ml-2 text-text-3">
                at ({element.rect.x}, {element.rect.y})
              </span>
            </div>
          </div>

          {/* Selector */}
          <div className="mb-3">
            <div className="mb-1 flex items-center text-[10px] font-medium uppercase text-text-3">
              Selector
              {renderCopyButton(element.selector, "selector")}
            </div>
            <div className="rounded bg-bg-3 px-3 py-1.5 font-mono text-[11px] text-primary-6">
              {element.selector}
            </div>
          </div>

          {/* XPath */}
          <div className="mb-3">
            <div className="mb-1 flex items-center text-[10px] font-medium uppercase text-text-3">
              XPath
              {renderCopyButton(element.xpath, "xpath")}
            </div>
            <div className="overflow-x-auto rounded bg-bg-3 px-3 py-1.5 font-mono text-[10px] text-text-2">
              {element.xpath}
            </div>
          </div>

          {/* Attributes */}
          {Object.keys(element.attributes).length > 0 && (
            <div className="mb-3">
              <div className="mb-1 text-[10px] font-medium uppercase text-text-3">
                Attributes
              </div>
              <div className="overflow-hidden rounded bg-bg-3">
                {Object.entries(element.attributes).map(([key, value]) => (
                  <div
                    key={key}
                    className="flex border-b border-border-1 px-3 py-1 text-[11px] last:border-b-0"
                  >
                    <span className="w-20 shrink-0 font-medium text-warning-6">
                      {key}
                    </span>
                    <span className="flex-1 truncate text-text-2" title={value}>
                      {value}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Computed Style */}
          <div className="mb-3">
            <div className="mb-1 text-[10px] font-medium uppercase text-text-3">
              Computed Style
            </div>
            <div className="overflow-hidden rounded bg-bg-3">
              {Object.entries(element.computedStyle)
                .filter(([_key, value]) => value)
                .map(([key, value]) => (
                  <div
                    key={key}
                    className="flex border-b border-border-1 px-3 py-1 text-[11px] last:border-b-0"
                  >
                    <span className="w-28 shrink-0 text-text-3">{key}</span>
                    <span className="flex-1 truncate font-mono text-text-2">
                      {value}
                    </span>
                  </div>
                ))}
            </div>
          </div>

          {/* Inner Text */}
          {element.innerText && (
            <div className="mb-3">
              <div className="mb-1 flex items-center text-[10px] font-medium uppercase text-text-3">
                Inner Text
                {renderCopyButton(element.innerText, "innerText")}
              </div>
              <div className="max-h-24 overflow-y-auto rounded bg-bg-3 px-3 py-1.5 text-[11px] text-text-2">
                {element.innerText.length > 200
                  ? element.innerText.substring(0, 200) + "..."
                  : element.innerText}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }
);

ElementsTab.displayName = "ElementsTab";

export default ElementsTab;
