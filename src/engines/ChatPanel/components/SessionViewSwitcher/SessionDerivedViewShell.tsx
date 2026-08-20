/**
 * Common chrome for the derived per-session views: a summary strip plus the
 * loading / error / empty states, so Timeline and Changes only own their rows.
 */
import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";
import { CHAT_PANEL_GLASS_SURFACE_CLASS } from "@src/engines/ChatPanel/header/chatPanelHeaderLayout";

export interface SessionDerivedViewShellProps {
  testId: string;
  loading: boolean;
  error: string | null;
  isEmpty: boolean;
  emptyLabel: string;
  /** Right-aligned one-line stat strip; hidden while empty. */
  summary: React.ReactNode;
  children: React.ReactNode;
  /** Space reserved for host chrome that overlays the view. */
  topInset?: number;
}

export const SessionDerivedViewShell: React.FC<SessionDerivedViewShellProps> =
  memo(
    ({
      testId,
      loading,
      error,
      isEmpty,
      emptyLabel,
      summary,
      children,
      topInset = 0,
    }) => {
      const { t } = useTranslation("common");

      const insetStyle = topInset > 0 ? { paddingTop: topInset } : undefined;

      if (error) {
        return (
          <div className="flex min-h-0 flex-1 flex-col" style={insetStyle}>
            <div
              role="alert"
              data-testid={`${testId}-error`}
              className="m-3 rounded-md border border-danger-6/40 bg-danger-1 px-3 py-2 text-sm text-danger-6"
            >
              {error}
            </div>
          </div>
        );
      }

      // Loading only takes the surface before the first rows arrive; a reload
      // over existing rows keeps them on screen instead of flashing empty.
      if (loading && isEmpty) {
        return (
          <div
            data-testid={`${testId}-loading`}
            className="flex flex-1 items-center justify-center text-sm text-text-3"
            style={insetStyle}
          >
            {t("status.loading", { defaultValue: "Loading…" })}
          </div>
        );
      }

      if (isEmpty) {
        return (
          <div
            data-testid={`${testId}-empty`}
            className="flex flex-1 items-center justify-center text-sm text-text-3"
            style={insetStyle}
          >
            {emptyLabel}
          </div>
        );
      }

      const summaryStrip = (
        <div
          className={`shrink-0 border-b border-border-2 ${
            topInset > 0 ? CHAT_PANEL_GLASS_SURFACE_CLASS : ""
          }`}
          data-testid={`${testId}-summary`}
        >
          {/* Capped to the same 900px as the rows below, so the stats sit over
              the right edge of the content rather than the panel. */}
          <div
            className={`flex h-8 items-center justify-end px-3 text-xs text-text-3 ${DETAIL_PANEL_TOKENS.contentWidth}`}
          >
            {summary}
          </div>
        </div>
      );

      return (
        <div
          data-testid={testId}
          className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
          style={insetStyle}
        >
          {summaryStrip}
          <div className="min-h-0 flex-1">{children}</div>
        </div>
      );
    }
  );

SessionDerivedViewShell.displayName = "SessionDerivedViewShell";
