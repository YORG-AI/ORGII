/**
 * Header pieces and body dispatcher for the per-session view switch, shared by
 * the chat pane and the Workstation `chat-session` tab so both hosts render an
 * identical control.
 *
 * - `SessionHeaderViewControls` owns the published-header leading slot:
 *   breadcrumb, separator, and the ghost mode select.
 * - `SessionRawToolbarActions` owns the trailing Refresh/Copy pair, which only
 *   applies to Raw and renders nothing in the other views.
 * - `SessionAlternateSurface` owns every non-GUI body. It mounts only the view
 *   in play, so neither the raw document nor the turn index is held while the
 *   reader is back in the transcript.
 */
import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Select from "@src/components/Select";
import { ClipboardIcon, HugeiconsIcon, Refresh04Icon } from "@src/icons";
import type { Session } from "@src/store/session";

import { useSessionTurnIndex } from "../../hooks/useSessionTurnIndex";
import type { UseSessionViewModeResult } from "../../hooks/useSessionViewMode";
import SessionHeaderBreadcrumb, {
  type SessionHeaderParentTarget,
} from "../SessionHeaderBreadcrumb";
import SessionRawTranscriptView from "../SessionRawTranscriptView";
import SessionChangesView from "./SessionChangesView";
import SessionTimelineView from "./SessionTimelineView";

const RAW_ACTION_ICON_SIZE = 14;

export const SESSION_VIEW_SELECTOR_CLASS =
  "!gap-1 !px-1 [&_.select-suffix]:!ml-0 [&_.select-value>span:last-child]:hidden " +
  "@[600px]/sessionview:!gap-2 @[600px]/sessionview:[&_.select-suffix]:!ml-1 " +
  "@[600px]/sessionview:[&_.select-value>span:last-child]:inline";

interface SessionHeaderViewControlsProps {
  session: Session | null | undefined;
  sessionId: string;
  fallbackName: string;
  onParentSessionClick?: (target: SessionHeaderParentTarget) => void;
  view: UseSessionViewModeResult;
  /** Test id prefix so each host keeps distinguishable selectors. */
  testIdPrefix: string;
}

export const SessionHeaderViewControls: React.FC<SessionHeaderViewControlsProps> =
  memo(
    ({
      session,
      sessionId,
      fallbackName,
      onParentSessionClick,
      view,
      testIdPrefix,
    }) => {
      const selectedOption = view.options.find(
        (option) => "value" in option && option.value === view.mode
      );
      const selectedLabel =
        selectedOption && "label" in selectedOption
          ? (selectedOption.triggerLabel ?? selectedOption.label)
          : undefined;
      const ariaLabel =
        typeof selectedLabel === "string" ? selectedLabel : undefined;

      return (
        <div className="flex min-w-0 flex-1 items-center gap-1.5 @container/sessionview">
          <SessionHeaderBreadcrumb
            session={session}
            sessionId={sessionId}
            fallbackName={fallbackName}
            onParentSessionClick={onParentSessionClick}
          />
          {view.switchable && (
            <>
              <Select
                value={view.mode}
                options={view.options}
                onChange={view.onChange}
                size="small"
                appearance="ghost"
                radius="lg"
                dropdownAlign="right"
                dropdownMinWidth={160}
                dropdownWidthMode="auto"
                className="w-auto shrink-0"
                selectorClassName={SESSION_VIEW_SELECTOR_CLASS}
                dataTestId={`${testIdPrefix}-view-select`}
                ariaLabel={ariaLabel}
              />
              <span
                className="pointer-events-none mx-1.5 h-4 w-px shrink-0 bg-border-2"
                aria-hidden
              />
            </>
          )}
        </div>
      );
    }
  );

SessionHeaderViewControls.displayName = "SessionHeaderViewControls";

interface SessionRawToolbarActionsProps {
  view: UseSessionViewModeResult;
  /** Test id prefix so each host keeps distinguishable selectors. */
  testIdPrefix: string;
}

export const SessionRawToolbarActions: React.FC<SessionRawToolbarActionsProps> =
  memo(({ view, testIdPrefix }) => {
    const { t } = useTranslation(["sessions", "common"]);
    const { isRaw, transcript } = view;
    if (!isRaw) return null;

    const refreshLabel = t("common:actions.refresh", "Refresh");
    const copyLabel = t("common:actions.copy", "Copy");

    return (
      <>
        <Button
          size="small"
          variant="tertiary"
          icon={
            <HugeiconsIcon
              icon={Refresh04Icon}
              data-icon="refresh-cw"
              size={RAW_ACTION_ICON_SIZE}
              strokeWidth={2}
            />
          }
          iconOnly
          loading={transcript.loading}
          aria-label={refreshLabel}
          title={refreshLabel}
          data-testid={`${testIdPrefix}-raw-refresh-button`}
          onClick={() => void transcript.loadTranscript()}
        />
        <Button
          size="small"
          variant="tertiary"
          icon={
            <HugeiconsIcon
              icon={ClipboardIcon}
              data-icon="clipboard"
              size={RAW_ACTION_ICON_SIZE}
              strokeWidth={2}
            />
          }
          iconOnly
          disabled={!transcript.snapshot || transcript.loading}
          aria-label={copyLabel}
          title={copyLabel}
          data-testid={`${testIdPrefix}-raw-copy-button`}
          onClick={() => void transcript.copyTranscript()}
        />
      </>
    );
  });

SessionRawToolbarActions.displayName = "SessionRawToolbarActions";

interface SessionAlternateSurfaceProps {
  sessionId: string | null;
  view: UseSessionViewModeResult;
  /** Space reserved for host chrome that overlays the view. */
  topInset?: number;
}

/**
 * Body for every non-GUI view. Renders nothing in "gui" so the host can keep
 * the transcript mounted underneath without a second surface fighting it.
 */
export const SessionAlternateSurface: React.FC<SessionAlternateSurfaceProps> =
  memo(({ sessionId, view, topInset = 0 }) => {
    const { mode } = view;
    const needsTurnIndex = mode === "timeline" || mode === "changes";
    const turnIndex = useSessionTurnIndex(sessionId, needsTurnIndex);

    if (!sessionId) return null;
    if (mode === "raw") {
      return (
        <SessionRawTranscriptView
          sessionId={sessionId}
          transcript={view.transcript}
          topInset={topInset}
        />
      );
    }
    if (mode === "timeline") {
      return (
        <SessionTimelineView
          turns={turnIndex.turns}
          loading={turnIndex.loading}
          error={turnIndex.error}
          topInset={topInset}
        />
      );
    }
    if (mode === "changes") {
      return (
        <SessionChangesView
          turns={turnIndex.turns}
          loading={turnIndex.loading}
          error={turnIndex.error}
          topInset={topInset}
        />
      );
    }
    return null;
  });

SessionAlternateSurface.displayName = "SessionAlternateSurface";
