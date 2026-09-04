import React from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { useRefreshSpin } from "@src/hooks/ui";
import {
  ArrowDown02Icon,
  ArrowExpand01Icon,
  ArrowUp02Icon,
  Cancel01Icon,
  HugeiconsIcon,
  Refresh04Icon,
} from "@src/icons";
import {
  COLLAPSIBLE_SECTION_TOKENS,
  PANEL_HEADER_TOKENS,
} from "@src/modules/shared/layouts/blocks";

interface DetailHeaderCloseProps {
  onClick: () => void;
  onExpand?: () => void;
  onRefresh?: () => void;
  refreshLoading?: boolean;
  onPrev?: () => void;
  onNext?: () => void;
  hasPrev?: boolean;
  hasNext?: boolean;
}

/**
 * Reusable close/expand/refresh buttons for detail panel headers.
 * Pattern: [↑?] [↓?] | [Refresh] [Expand] [X] — each arrow only when that direction exists.
 * Nav buttons use PANEL_HEADER_TOKENS.actionButton (same as refresh/expand/close).
 * Spacing comes from PanelHeader actions row (gap-2); do not wrap nav in a tighter gap.
 */
export const DetailHeaderClose: React.FC<DetailHeaderCloseProps> = ({
  onClick,
  onExpand,
  onRefresh,
  refreshLoading = false,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
}) => {
  const { t } = useTranslation();
  const { spinClass, handleClick: handleRefreshClick } = useRefreshSpin(
    onRefresh ?? (() => {}),
    refreshLoading
  );

  /** Same glyph props as PanelHeader action icons (see PANEL_HEADER_TOKENS). */
  const headerIconProps = {
    size: PANEL_HEADER_TOKENS.buttonIconSize,
    strokeWidth: PANEL_HEADER_TOKENS.iconStrokeWidth,
  } as const;

  const hasNavigationCallbacks = onPrev !== undefined && onNext !== undefined;
  const showPrevButton = hasNavigationCallbacks && (hasPrev ?? false);
  const showNextButton = hasNavigationCallbacks && (hasNext ?? false);
  const showNavSeparator = showPrevButton || showNextButton;

  return (
    <>
      {showPrevButton && (
        <Button
          {...PANEL_HEADER_TOKENS.actionButton}
          icon={
            <HugeiconsIcon
              icon={ArrowUp02Icon}
              data-icon="arrow-up"
              {...headerIconProps}
            />
          }
          onClick={onPrev}
          title={t("actions.previous")}
        />
      )}
      {showNextButton && (
        <Button
          {...PANEL_HEADER_TOKENS.actionButton}
          icon={
            <HugeiconsIcon
              icon={ArrowDown02Icon}
              data-icon="arrow-down"
              {...headerIconProps}
            />
          }
          onClick={onNext}
          title={t("actions.next")}
        />
      )}
      {showNavSeparator && (
        <div className={COLLAPSIBLE_SECTION_TOKENS.separator} />
      )}
      {onRefresh && (
        <Button
          {...PANEL_HEADER_TOKENS.actionButton}
          icon={
            <HugeiconsIcon
              icon={Refresh04Icon}
              data-icon="refresh-cw"
              {...headerIconProps}
              className={spinClass}
            />
          }
          onClick={handleRefreshClick}
          title={t("actions.refresh")}
        />
      )}
      {onExpand && (
        <Button
          {...PANEL_HEADER_TOKENS.actionButton}
          icon={
            <HugeiconsIcon
              icon={ArrowExpand01Icon}
              data-icon="maximize-2"
              {...headerIconProps}
            />
          }
          onClick={onExpand}
          title={t("actions.expand")}
        />
      )}
      <Button
        {...PANEL_HEADER_TOKENS.actionButton}
        icon={
          <HugeiconsIcon
            icon={Cancel01Icon}
            data-icon="x"
            {...headerIconProps}
          />
        }
        onClick={onClick}
        title={t("actions.close")}
      />
    </>
  );
};
