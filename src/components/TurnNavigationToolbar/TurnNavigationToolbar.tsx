/**
 * TurnNavigationToolbar
 *
 * Shared round selector trigger, timestamp, and prev/next/latest controls
 * used by desktop ChatHistory and Mobile Remote.
 */
import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { DROPDOWN_ITEM } from "@src/components/Dropdown/tokens";
import { HeaderSectionSeparator } from "@src/components/HeaderSectionSeparator";
import { KeyboardShortcutTooltipContent } from "@src/components/KeyboardShortcut";
import Tooltip from "@src/components/Tooltip";
import { SURFACE_TOKENS } from "@src/config/surfaceTokens";
import {
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowRightDoubleIcon,
  Cancel01Icon,
  ClockArrowDownIcon,
  ClockArrowUpIcon,
  HugeiconsIcon,
  Loading03Icon,
} from "@src/icons";

import { shouldShowTurnPaginationSpinner } from "./shouldShowTurnPaginationSpinner";

const SELECT_TRIGGER_BASE =
  "flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-lg px-2 text-[13px] font-normal text-text-1 transition-colors";
const SELECT_CHEVRON_CLASS = "shrink-0 text-text-3 transition-transform";

export interface TurnNavigationToolbarProps {
  variant?: "desktop" | "mobile";
  className?: string;
  enabled?: boolean;
  ready: boolean;
  listOpen: boolean;
  onToggleList: () => void;
  sortAscending: boolean;
  onToggleSort: () => void;
  onCloseList: () => void;
  currentLabel: string;
  currentTimeLabel: string;
  currentIndex: number;
  pageCount: number;
  onPrevious: () => void;
  onNext: () => void;
  onLatest: () => void;
  leading?: React.ReactNode;
  trailingAfterSelector?: React.ReactNode;
  statusAnnotation?: React.ReactNode;
  ariaLabel?: string;
}

const TurnNavigationToolbar: React.FC<TurnNavigationToolbarProps> = memo(
  ({
    variant = "desktop",
    className = "",
    enabled = true,
    ready,
    listOpen,
    onToggleList,
    sortAscending,
    onToggleSort,
    onCloseList,
    currentLabel,
    currentTimeLabel,
    currentIndex,
    pageCount,
    onPrevious,
    onNext,
    onLatest,
    leading,
    trailingAfterSelector,
    statusAnnotation,
    ariaLabel,
  }) => {
    const { t } = useTranslation();
    const showTurnPaginationSpinner = shouldShowTurnPaginationSpinner({
      turnPaginationReady: ready,
      pageCount,
    });
    const isMobile = variant === "mobile";
    const rootClassName = isMobile
      ? `flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border-2 bg-bg-1 px-3 py-2 ${className}`.trim()
      : `flex h-10 min-h-10 shrink-0 items-center justify-between gap-2 px-2 text-xs text-text-3 ${className}`.trim();

    if (!enabled) return null;

    return (
      <nav
        className={rootClassName}
        aria-label={ariaLabel ?? t("common:pagination.latestRound")}
        data-turn-navigation-toolbar={variant}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {leading}
          <div className="relative min-w-0">
            <button
              type="button"
              data-testid="turn-pagination-current-round"
              className={`${SELECT_TRIGGER_BASE} cursor-pointer ${SURFACE_TOKENS.hover} disabled:cursor-not-allowed disabled:opacity-50 ${
                listOpen ? SURFACE_TOKENS.selected : ""
              }`}
              disabled={!ready}
              onClick={() => {
                if (!ready) return;
                onToggleList();
              }}
            >
              <span className="truncate">{currentLabel}</span>
              {showTurnPaginationSpinner ? (
                <HugeiconsIcon
                  icon={Loading03Icon}
                  data-icon="loader-2"
                  size={DROPDOWN_ITEM.iconSize}
                  className="shrink-0 animate-spin text-text-3"
                />
              ) : (
                <HugeiconsIcon
                  icon={ArrowDown01Icon}
                  data-icon="chevron-down"
                  size={DROPDOWN_ITEM.iconSize}
                  className={`${SELECT_CHEVRON_CLASS} ${
                    listOpen ? "rotate-180" : ""
                  }`}
                />
              )}
            </button>
          </div>
          {trailingAfterSelector ? (
            <>
              <HeaderSectionSeparator />
              {trailingAfterSelector}
            </>
          ) : null}
          {statusAnnotation ? (
            <span className="min-w-0 text-xs text-text-3">
              {statusAnnotation}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {!listOpen && currentTimeLabel ? (
            <span className="px-1 text-[13px] whitespace-nowrap text-text-3 tabular-nums">
              {currentTimeLabel}
            </span>
          ) : null}
          <div className="flex shrink-0 items-center gap-px">
            {listOpen ? (
              <>
                <Tooltip
                  content={
                    <KeyboardShortcutTooltipContent
                      label={t("common:actions.sort")}
                    />
                  }
                  position="bottom-end"
                  mouseEnterDelay={200}
                  framedPanel
                >
                  <span className="inline-flex">
                    <Button
                      htmlType="button"
                      variant="tertiary"
                      size="small"
                      iconOnly
                      onClick={onToggleSort}
                      aria-label={t("common:actions.sort")}
                      icon={
                        sortAscending ? (
                          <HugeiconsIcon
                            icon={ClockArrowDownIcon}
                            data-icon="clock-arrow-down"
                            size={DROPDOWN_ITEM.iconSize}
                            strokeWidth={1.75}
                          />
                        ) : (
                          <HugeiconsIcon
                            icon={ClockArrowUpIcon}
                            data-icon="clock-arrow-up"
                            size={DROPDOWN_ITEM.iconSize}
                            strokeWidth={1.75}
                          />
                        )
                      }
                    />
                  </span>
                </Tooltip>
                <Tooltip
                  content={
                    <KeyboardShortcutTooltipContent
                      label={t("common:actions.close")}
                    />
                  }
                  position="bottom-end"
                  mouseEnterDelay={200}
                  framedPanel
                >
                  <span className="inline-flex">
                    <Button
                      htmlType="button"
                      variant="tertiary"
                      size="small"
                      iconOnly
                      onClick={onCloseList}
                      aria-label={t("common:actions.close")}
                      icon={
                        <HugeiconsIcon
                          icon={Cancel01Icon}
                          data-icon="x"
                          size={DROPDOWN_ITEM.iconSize}
                          strokeWidth={1.75}
                        />
                      }
                    />
                  </span>
                </Tooltip>
              </>
            ) : (
              <>
                <Tooltip
                  content={
                    <KeyboardShortcutTooltipContent
                      label={t("common:pagination.previousRound")}
                    />
                  }
                  position="bottom-end"
                  mouseEnterDelay={200}
                  framedPanel={!isMobile}
                  disabled={isMobile}
                >
                  <span className="inline-flex">
                    <Button
                      htmlType="button"
                      variant="tertiary"
                      size="small"
                      iconOnly
                      data-testid="turn-pagination-previous-round"
                      onClick={onPrevious}
                      disabled={!ready || currentIndex <= 0}
                      aria-label={t("common:pagination.previousRound")}
                      icon={
                        <HugeiconsIcon
                          icon={ArrowLeft01Icon}
                          data-icon="chevron-left"
                          size={DROPDOWN_ITEM.iconSize}
                          strokeWidth={1.75}
                        />
                      }
                    />
                  </span>
                </Tooltip>
                <Tooltip
                  content={
                    <KeyboardShortcutTooltipContent
                      label={t("common:pagination.nextRound")}
                    />
                  }
                  position="bottom-end"
                  mouseEnterDelay={200}
                  framedPanel={!isMobile}
                  disabled={isMobile}
                >
                  <span className="inline-flex">
                    <Button
                      htmlType="button"
                      variant="tertiary"
                      size="small"
                      iconOnly
                      data-testid="turn-pagination-next-round"
                      onClick={onNext}
                      disabled={!ready || currentIndex >= pageCount - 1}
                      aria-label={t("common:pagination.nextRound")}
                      icon={
                        <HugeiconsIcon
                          icon={ArrowRight01Icon}
                          data-icon="chevron-right"
                          size={DROPDOWN_ITEM.iconSize}
                          strokeWidth={1.75}
                        />
                      }
                    />
                  </span>
                </Tooltip>
                <Tooltip
                  content={
                    <KeyboardShortcutTooltipContent
                      label={t("common:pagination.latestRound")}
                    />
                  }
                  position="bottom-end"
                  mouseEnterDelay={200}
                  framedPanel={!isMobile}
                  disabled={isMobile}
                >
                  <span className="inline-flex">
                    <Button
                      htmlType="button"
                      variant="tertiary"
                      size="small"
                      iconOnly
                      data-testid="turn-pagination-last-round"
                      onClick={onLatest}
                      disabled={!ready || currentIndex >= pageCount - 1}
                      aria-label={t("common:pagination.latestRound")}
                      icon={
                        <HugeiconsIcon
                          icon={ArrowRightDoubleIcon}
                          data-icon="chevrons-right"
                          size={18}
                          strokeWidth={1.75}
                          className="translate-y-[0.5px]"
                        />
                      }
                    />
                  </span>
                </Tooltip>
              </>
            )}
          </div>
        </div>
      </nav>
    );
  }
);

TurnNavigationToolbar.displayName = "TurnNavigationToolbar";

export default TurnNavigationToolbar;
