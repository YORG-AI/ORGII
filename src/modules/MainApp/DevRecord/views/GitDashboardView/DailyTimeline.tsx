/**
 * DailyTimeline — commit activity feed using SettingsTable.
 *
 * Flat list of commits sorted by time (newest first), showing
 * time, commit summary, author, and +/- diff stats.
 */
import React, { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { GitCommitInfo } from "@src/api/http/git/types";
import DiffStatsBadge from "@src/components/DiffStatsBadge";
import SettingsTable, {
  SETTINGS_TABLE_CELL,
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
} from "@src/components/SettingsTable";
import {
  CollapsibleSection,
  Placeholder,
} from "@src/modules/shared/layouts/blocks";

import { getContributorColor } from "./config";
import type { CommitStatsEntry } from "./types";

// ============================================
// Types
// ============================================

interface CommitRow {
  sha: string;
  summary: string;
  authorName: string;
  authorColor: string;
  timestamp: number;
  insertions: number;
  deletions: number;
  filesChanged: number;
}

interface DailyTimelineProps {
  commits: GitCommitInfo[];
  statsMap: Map<string, CommitStatsEntry>;
}

// ============================================
// DailyTimeline
// ============================================

const DailyTimeline: React.FC<DailyTimelineProps> = memo(
  ({ commits, statsMap }) => {
    const { t } = useTranslation();

    const { rows } = useMemo(() => {
      const authorSet = new Set<string>();
      for (const commit of commits) {
        authorSet.add(commit.author?.name ?? "Unknown");
      }
      const sortedAuthors = Array.from(authorSet).sort();
      const colorMap = new Map<string, string>();
      sortedAuthors.forEach((author, idx) => {
        colorMap.set(author, getContributorColor(idx));
      });

      const mapped: CommitRow[] = commits.map((commit) => {
        const date = new Date(commit.author?.date ?? 0);
        const stat = statsMap.get(commit.sha);
        const author = commit.author?.name ?? "Unknown";
        return {
          sha: commit.sha,
          summary: commit.summary,
          authorName: author,
          authorColor: colorMap.get(author) ?? "var(--color-primary-6)",
          timestamp: date.getTime(),
          insertions: stat?.insertions ?? 0,
          deletions: stat?.deletions ?? 0,
          filesChanged: stat?.filesChanged ?? 0,
        };
      });

      mapped.sort((rowA, rowB) => rowB.timestamp - rowA.timestamp);
      return { rows: mapped };
    }, [commits, statsMap]);

    const columns = useMemo<SettingsTableColumn<CommitRow>[]>(
      () => [
        {
          key: "time",
          label: t("devActivity.cursorTime"),
          width: SETTINGS_TABLE_COL.valueMd,
          sorter: (rowA, rowB) => rowB.timestamp - rowA.timestamp,
          renderCell: (row) => (
            <span
              className={`${SETTINGS_TABLE_CELL.value} whitespace-nowrap tabular-nums`}
            >
              {new Date(row.timestamp).toLocaleDateString([], {
                month: "numeric",
                day: "numeric",
              })}{" "}
              {new Date(row.timestamp).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
              })}
            </span>
          ),
        },
        {
          key: "summary",
          label: t("gitDashboard.commits"),
          width: SETTINGS_TABLE_COL.fill,
          renderCell: (row) => (
            <span
              className={`${SETTINGS_TABLE_CELL.primary} block truncate`}
              title={row.summary}
            >
              {row.summary}
            </span>
          ),
        },
        {
          key: "author",
          label: t("gitDashboard.author"),
          width: SETTINGS_TABLE_COL.valueMd,
          renderCell: (row) => (
            <span className="flex items-center gap-1.5 whitespace-nowrap">
              <span
                className="inline-block h-2 w-2 shrink-0 rounded-full"
                style={{ backgroundColor: row.authorColor }}
              />
              <span className={SETTINGS_TABLE_CELL.muted}>
                {row.authorName}
              </span>
            </span>
          ),
        },
        {
          key: "files",
          label: t("devActivity.filesTouched"),
          width: "80px",
          align: "right",
          sorter: (rowA, rowB) => rowA.filesChanged - rowB.filesChanged,
          renderCell: (row) =>
            row.filesChanged > 0 ? (
              <span className={`${SETTINGS_TABLE_CELL.value} tabular-nums`}>
                {row.filesChanged}
              </span>
            ) : (
              <span className={SETTINGS_TABLE_CELL.muted}>—</span>
            ),
        },
        {
          key: "diff",
          label: t("devActivity.linesChanged"),
          width: "200px",
          align: "right",
          sorter: (rowA, rowB) =>
            rowA.insertions +
            rowA.deletions -
            (rowB.insertions + rowB.deletions),
          renderCell: (row) =>
            row.insertions > 0 || row.deletions > 0 ? (
              <DiffStatsBadge
                additions={row.insertions}
                deletions={row.deletions}
                variant="plain"
                className="justify-end gap-x-3"
                formatValue={(value) => value.toLocaleString()}
              />
            ) : (
              <span className={SETTINGS_TABLE_CELL.muted}>—</span>
            ),
        },
      ],
      [t]
    );

    return (
      <CollapsibleSection title={t("gitDashboard.dailyActivity")}>
        {rows.length === 0 ? (
          <Placeholder variant="empty" title={t("gitDashboard.noCommitData")} />
        ) : (
          <SettingsTable<CommitRow>
            columns={columns}
            rows={rows}
            getRowKey={(row) => row.sha}
            headerHeight="tall"
            pageSize={50}
            maxHeight="min(420px, calc(100vh - 280px))"
            className="[&_.table]:table-fixed"
          />
        )}
      </CollapsibleSection>
    );
  }
);

DailyTimeline.displayName = "DailyTimeline";

export default DailyTimeline;
