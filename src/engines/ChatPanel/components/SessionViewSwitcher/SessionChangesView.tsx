/**
 * What one session did to the working tree: every file it wrote, aggregated
 * across turns, busiest first.
 *
 * Same single turn-index read as the Timeline view, and virtualized for the
 * same reason — a long refactor session can touch hundreds of paths.
 */
import React, { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { VirtualizedListBase } from "@src/components/TreeRow";
import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";

import { SessionDerivedViewShell } from "./SessionDerivedViewShell";
import type { ChangedFileRow } from "./sessionViewProjections";
import { projectSessionChanges } from "./sessionViewProjections";
import type { SessionDerivedViewProps } from "./types";

const ROW_HEIGHT = 34;

const STATUS_TONE: Record<ChangedFileRow["status"], string> = {
  created: "bg-success-6",
  modified: "bg-warning-6",
  deleted: "bg-danger-6",
};

const ChangedFileRowView: React.FC<{ row: ChangedFileRow }> = memo(
  ({ row }) => {
    const { t } = useTranslation("sessions");
    return (
      <div
        // Same 900px cap the transcript rows use, so switching views does not
        // change how wide the session reads.
        className={`flex h-[34px] items-center gap-2 px-3 text-xs ${DETAIL_PANEL_TOKENS.contentWidth}`}
        data-testid="session-changes-row"
        data-path={row.path}
      >
        <span
          className={`size-1.5 shrink-0 rounded-full ${STATUS_TONE[row.status]}`}
          aria-hidden
        />
        <span className="shrink-0 truncate text-text-1">{row.fileName}</span>
        <span className="min-w-0 flex-1 truncate text-text-3" title={row.path}>
          {row.path}
        </span>
        {row.turnCount > 1 && (
          <span className="shrink-0 tabular-nums text-text-3">
            {t("chat.sessionViews.turnCount", {
              count: row.turnCount,
              defaultValue: "{{count}} turns",
            })}
          </span>
        )}
        <span className="w-12 shrink-0 text-right tabular-nums text-success-6">
          {row.additions > 0 ? `+${row.additions}` : ""}
        </span>
        <span className="w-12 shrink-0 text-right tabular-nums text-danger-6">
          {row.deletions > 0 ? `−${row.deletions}` : ""}
        </span>
      </div>
    );
  }
);

ChangedFileRowView.displayName = "ChangedFileRowView";

const SessionChangesView: React.FC<SessionDerivedViewProps> = memo(
  ({ turns, loading, error }) => {
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
        summary={
          <span className="flex items-center gap-2">
            <span>
              {t("chat.sessionViews.fileCount", {
                count: changes.files.length,
                defaultValue: "{{count}} files",
              })}
            </span>
            <span className="tabular-nums text-success-6">
              +{changes.totalAdditions}
            </span>
            <span className="tabular-nums text-danger-6">
              −{changes.totalDeletions}
            </span>
          </span>
        }
      >
        <VirtualizedListBase<ChangedFileRow>
          items={changes.files}
          itemHeight={ROW_HEIGHT}
          computeItemKey={(row) => row.path}
          getItemPath={(row) => row.path}
          renderItem={(row) => <ChangedFileRowView row={row} />}
        />
      </SessionDerivedViewShell>
    );
  }
);

SessionChangesView.displayName = "SessionChangesView";

export default SessionChangesView;
