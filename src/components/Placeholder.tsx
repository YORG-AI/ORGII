import { Loader2 } from "lucide-react";
import React, { memo, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { SPINNER_TOKENS } from "@src/config/spinnerTokens";
import { TYPOGRAPHY } from "@src/config/workstation/tokens";

export const PLACEHOLDER_TOKENS = { iconSize: 32 } as const;
const LOADING_PLACEHOLDER_DEBOUNCE_MS = 250;
type BaseVariant = "empty" | "loading" | "error" | "no-results";
type ContentPresetVariant =
  | "no-file"
  | "no-tabs"
  | "no-connection"
  | "no-query";
export type PlaceholderVariant = BaseVariant | ContentPresetVariant;
export type PlaceholderPlacement = "sidebar" | "detail-panel";
const CONTENT_PRESET_VARIANTS = new Set<PlaceholderVariant>([
  "no-file",
  "no-tabs",
  "no-connection",
  "no-query",
]);

export interface PlaceholderProps {
  variant: PlaceholderVariant;
  placement?: PlaceholderPlacement;
  title?: string;
  subtitle?: string;
  action?: {
    label: string;
    onClick: () => void;
    variant?: "primary" | "secondary";
    disabled?: boolean;
    dataTestId?: string;
  };
  onRetry?: () => void;
  icon?: React.ReactNode;
  fillParentHeight?: boolean;
  className?: string;
}

interface DefaultText {
  title: string;
  subtitle?: string;
}

export const Placeholder: React.FC<PlaceholderProps> = memo(
  ({
    variant,
    placement,
    title,
    subtitle,
    action,
    onRetry,
    icon,
    fillParentHeight = false,
    className = "",
  }) => {
    const { t } = useTranslation();
    const resolvedPlacement: PlaceholderPlacement =
      placement ??
      (CONTENT_PRESET_VARIANTS.has(variant) ? "detail-panel" : "sidebar");
    const defaults: Record<PlaceholderVariant, DefaultText> = {
      empty: { title: t("placeholders.nothingHereYet") },
      loading: { title: t("status.loading") },
      error: { title: t("errors.failedToLoad") },
      "no-results": { title: t("placeholders.noMatchingResults") },
      "no-file": {
        title: t("placeholders.noFileOpen"),
        subtitle: t("placeholders.selectFileToEdit"),
      },
      "no-tabs": {
        title: t("placeholders.noTabsOpen"),
        subtitle: t("placeholders.selectItemToStart"),
      },
      "no-connection": {
        title: t("placeholders.noDatabaseConnected"),
        subtitle: t("placeholders.addConnectionToQuery"),
      },
      "no-query": {
        title: t("placeholders.noQueryResults"),
        subtitle: t("placeholders.runQueryToSeeResults"),
      },
    };
    const defaultText = defaults[variant];
    const resolvedTitle = title ?? defaultText.title;
    const resolvedSubtitle = subtitle ?? defaultText.subtitle;
    const isError = variant === "error";
    const isLoading = variant === "loading";
    const resolvedAction =
      action ??
      (onRetry && isError
        ? { label: t("actions.retry"), onClick: onRetry }
        : undefined);
    const isDetailPanel = resolvedPlacement === "detail-panel";
    const titleClass = isDetailPanel
      ? TYPOGRAPHY.contentTitle
      : TYPOGRAPHY.panelTitle;
    const subtitleClass = isDetailPanel
      ? TYPOGRAPHY.contentSubtitle
      : TYPOGRAPHY.panelSubtitle;
    const stretchClass =
      fillParentHeight && isDetailPanel
        ? "min-h-0 h-full w-full min-w-0 "
        : fillParentHeight
          ? "h-full w-full min-w-0 flex-1 "
          : "";
    const containerClass = isDetailPanel
      ? `${stretchClass}flex ${fillParentHeight ? "min-h-0" : "h-full"} w-full items-center justify-center ${className}`.trim()
      : `${stretchClass}flex ${fillParentHeight ? "" : "h-full "}flex-col items-center justify-center gap-1 p-4 text-center ${className}`.trim();

    if (isLoading) {
      return (
        <DebouncedLoadingSpinner
          containerClass={containerClass}
          title={resolvedTitle}
          subtitle={resolvedSubtitle}
          titleClass={titleClass}
          subtitleClass={subtitleClass}
          showLabel={isDetailPanel ? Boolean(title ?? subtitle) : true}
        />
      );
    }

    if (isDetailPanel) {
      return (
        <div className={containerClass}>
          <div className="text-center">
            {icon && (
              <div className="mb-3 flex justify-center text-text-4">{icon}</div>
            )}
            <div
              className={`${titleClass} ${isError ? "text-danger-6" : "text-text-2"}`}
            >
              {resolvedTitle}
            </div>
            {resolvedSubtitle && (
              <div className={`mt-1 ${subtitleClass} text-text-3`}>
                {resolvedSubtitle}
              </div>
            )}
            {resolvedAction && (
              <Button
                variant={resolvedAction.variant ?? "secondary"}
                size="small"
                className="mt-3"
                onClick={resolvedAction.onClick}
                disabled={resolvedAction.disabled}
                data-testid={resolvedAction.dataTestId}
              >
                {resolvedAction.label}
              </Button>
            )}
          </div>
        </div>
      );
    }

    return (
      <div className={containerClass}>
        <span
          className={`${titleClass} ${isError ? "text-danger-6" : "text-text-2"}`}
        >
          {resolvedTitle}
        </span>
        {resolvedSubtitle && (
          <span className={`${subtitleClass} text-text-3`}>
            {resolvedSubtitle}
          </span>
        )}
        {resolvedAction && (
          <Button
            variant={resolvedAction.variant ?? "secondary"}
            size="small"
            className="mt-2"
            onClick={resolvedAction.onClick}
            disabled={resolvedAction.disabled}
            data-testid={resolvedAction.dataTestId}
          >
            {resolvedAction.label}
          </Button>
        )}
      </div>
    );
  }
);
Placeholder.displayName = "Placeholder";

interface DebouncedLoadingSpinnerProps {
  containerClass: string;
  title: string;
  subtitle?: string;
  titleClass: string;
  subtitleClass: string;
  showLabel: boolean;
}

const DebouncedLoadingSpinner: React.FC<DebouncedLoadingSpinnerProps> = memo(
  ({
    containerClass,
    title,
    subtitle,
    titleClass,
    subtitleClass,
    showLabel,
  }) => {
    const [showSpinner, setShowSpinner] = useState(false);
    useEffect(() => {
      const timer = window.setTimeout(
        () => setShowSpinner(true),
        LOADING_PLACEHOLDER_DEBOUNCE_MS
      );
      return () => window.clearTimeout(timer);
    }, []);
    return (
      <div className={containerClass} aria-busy="true">
        {showSpinner && (
          <>
            <Loader2
              size={SPINNER_TOKENS.default}
              className="animate-spin text-text-3"
            />
            {showLabel ? (
              <>
                <span className={`${titleClass} text-text-2`}>{title}</span>
                {subtitle ? (
                  <span className={`${subtitleClass} text-text-3`}>
                    {subtitle}
                  </span>
                ) : null}
              </>
            ) : null}
          </>
        )}
      </div>
    );
  }
);
DebouncedLoadingSpinner.displayName = "DebouncedLoadingSpinner";
