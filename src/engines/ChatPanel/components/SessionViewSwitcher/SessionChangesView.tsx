/**
 * What one session did to the working tree: every file it wrote, aggregated
 * across turns, busiest first.
 *
 * Same single turn-index read as the Timeline view, and virtualized for the
 * same reason — a long refactor session can touch hundreds of paths.
 */
import React, { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";

import DiffStatsBadge from "@src/components/DiffStatsBadge";
import FileTypeIcon from "@src/components/FileTypeIcon";
import { VirtualizedListBase } from "@src/components/TreeRow";
import { CHAT_PANEL_WIDTH_TOKENS } from "@src/config/detailPanelTokens";

import { SessionDerivedViewShell } from "./SessionDerivedViewShell";
import type { ChangedFileRow } from "./sessionViewProjections";
import { projectSessionChanges } from "./sessionViewProjections";
import type { SessionDerivedViewProps } from "./types";

const ROW_HEIGHT = 34;

const ChangedFileRowView: React.FC<{ row: ChangedFileRow }> = memo(
  ({ row }) => {
    const { t } = useTranslation("sessions");
    return (
      <div
        // Same 800px cap the transcript rows use, so switching views does not
        // change how wide the session reads.
        className={`flex h-[34px] items-center gap-2 px-3 text-xs ${CHAT_PANEL_WIDTH_TOKENS.contentWidth}`}
        data-testid="session-changes-row"
        data-path={row.path}
      >
        <FileTypeIcon
          fileName={row.fileName}
          size="medium"
          className="shrink-0"
        />
        <span className="shrink-0 truncate text-text-1">{row.fileName}</span>
        <span className="min-w-0 flex-1 truncate text-text-3" title={row.path}>
          {row.path}
        </span>
        {row.turnCount > 1 && (
          <span className="shrink-0 text-text-3 tabular-nums">
            {t("chat.sessionViews.turnCount", {
              count: row.turnCount,
              defaultValue: "{{count}} turns",
            })}
          </span>
        )}
        <span
          className="flex w-28 shrink-0 justify-end"
          data-testid="session-changes-diff-stats"
        >
          <DiffStatsBadge
            additions={row.additions}
            deletions={row.deletions}
            variant="plain"
            size="sm"
            weight="normal"
          />
        </span>
      </div>
    );
  }
);

ChangedFileRowView.displayName = "ChangedFileRowView";

function computeChangedFileKey(row: ChangedFileRow): string {
  return row.path;
}

function getChangedFilePath(row: ChangedFileRow): string {
  return row.path;
}

function renderChangedFileRow(row: ChangedFileRow): React.ReactNode {
  return <ChangedFileRowView row={row} />;
}

const SessionChangesView: React.FC<SessionDerivedViewProps> = memo(
  ({ turns, loading, error, topInset }) => {
    const { t } = useTranslation("sessions");
    const changes = useMemo(() => projectSessionChanges(turns), [turns]);

    return (
      <SessionDerivedViewShell
        testId="session-changes-view"
        loading={loading}
        error={error}
        isEmpty={changes.files.length === 0}
        emptyLabel={t("chat.sessionViews.changesEmpty", {
          defaultValue: "This session did not write any files.",
        })}
        topInset={topInset}
        summary={
          <span className="flex items-center gap-2">
            <span>
              {t("chat.sessionViews.fileCount", {
                count: changes.files.length,
                defaultValue: "{{count}} files",
              })}
            </span>
            <DiffStatsBadge
              additions={changes.totalAdditions}
              deletions={changes.totalDeletions}
              variant="plain"
              size="sm"
              weight="normal"
              reserveValueWidth={false}
            />
          </span>
        }
      >
        <VirtualizedListBase<ChangedFileRow>
          items={changes.files}
          itemHeight={ROW_HEIGHT}
          computeItemKey={computeChangedFileKey}
          getItemPath={getChangedFilePath}
          renderItem={renderChangedFileRow}
        />
      </SessionDerivedViewShell>
    );
  }
);

SessionChangesView.displayName = "SessionChangesView";

export default SessionChangesView;
