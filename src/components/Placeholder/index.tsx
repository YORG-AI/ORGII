/**
 * Placeholder — Shared placeholder for panels and content areas.
 *
 * Use `placement` to control visual weight:
 * - "sidebar" (default): smaller text, no background — use for everything inside
 *   scrollable containers, page sections, embedded panels, lists.
 * - "detail-panel": larger text — ONLY for top-level panes where the
 *   placeholder fills the entire view (e.g., code editor no-file, database no-query).
 *   Does not set a background; the parent pane/shell should paint the surface.
 *
 * Content-preset variants ("no-file", "no-tabs", "no-connection", "no-query")
 * auto-resolve to placement="detail-panel".
 *
 * Use `fillParentHeight` when the placeholder should occupy the full height of a
 * flex or sized parent and keep the message vertically centered.
 */
import React, { memo, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { SPINNER_TOKENS } from "@src/config/spinnerTokens";
import { TYPOGRAPHY } from "@src/config/workstation/tokens";
import { HugeiconsIcon, Loading03Icon } from "@src/icons";

import { normalizePlaceholderSubtitle } from "./normalizePlaceholderSubtitle";

export const PLACEHOLDER_TOKENS = {
  iconSize: 32,
} as const;

/**
 * Debounce window for the `loading` variant spinner (ms).
 *
 * Most in-app loads (warm Tauri IPC, cached data hooks, lazy chunks)
 * resolve in 30–150ms. Rendering the spinner instantly causes a visible
 * "flash to spinner and back" on every sidebar click. By delaying the
 * first render of the spinner we turn fast loads into silent no-ops
 * while still surfacing a spinner for genuinely slow operations.
 *
 * The container box is still rendered during the debounce window so the
 * slot reserves space — nothing moves when the spinner finally appears.
 */
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
  /** Visual variant */
  variant: PlaceholderVariant;
  /**
   * Where the placeholder is rendered.
   * - "sidebar": smaller text, no background (default)
   * - "detail-panel": larger text, no background (parent provides surface)
   *
   * Content-preset variants auto-resolve to "detail-panel".
   */
  placement?: PlaceholderPlacement;
  /** Primary message */
  title?: string;
  /** Secondary message */
  subtitle?: string;
  /** Optional action button */
  action?: {
    label: string;
    onClick: () => void;
    /** Button variant — defaults to "secondary" */
    variant?: "primary" | "secondary";
    disabled?: boolean;
    dataTestId?: string;
  };
  /** Shortcut: retry handler for error variant */
  onRetry?: () => void;
  /** Optional icon rendered above the title (detail-panel only, ignored when loading) */
  icon?: React.ReactNode;
  /**
   * When true, stretches to fill the parent and keeps content vertically centered.
   * Detail-panel: `flex-1 min-h-0`; sidebar: `flex-1 h-full` (no `min-h-0` on root).
   */
  fillParentHeight?: boolean;
  /** Additional class name */
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
    const resolvedSubtitle = normalizePlaceholderSubtitle(
      subtitle ?? defaultText.subtitle
    );
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
    /**
     * Detail-panel + fillParentHeight: use h-full (not flex-1) so the block fills non-flex parents
     * (e.g. AppShell Suspense wrappers). flex-1 only works as a flex item; without a flex parent the
     * placeholder had no height and the spinner sat at the top instead of vertically centered.
     * Sidebar fill still uses flex-1 where the parent is a flex column.
     */
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
  /** Detail-panel keeps spinner-only unless an explicit title/subtitle was passed. */
  showLabel: boolean;
}

/**
 * Renders the `Placeholder` loading spinner only after a short
 * debounce window. See {@link LOADING_PLACEHOLDER_DEBOUNCE_MS} for
 * the rationale; kept as a separate component so the timer state
 * doesn't bloat the main `Placeholder` render path.
 */
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
      const timer = window.setTimeout(() => {
        setShowSpinner(true);
      }, LOADING_PLACEHOLDER_DEBOUNCE_MS);
      return () => {
        window.clearTimeout(timer);
      };
    }, []);

    return (
      <div className={containerClass} aria-busy="true">
        {showSpinner && (
          <>
            <HugeiconsIcon
              icon={Loading03Icon}
              data-icon="loader-2"
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
