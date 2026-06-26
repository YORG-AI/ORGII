import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import DiffStatsBadge from "@src/components/DiffStatsBadge";
import SettingsTable, {
  SETTINGS_TABLE_CELL,
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
} from "@src/components/SettingsTable";
import { CollapsibleSection } from "@src/modules/shared/layouts/blocks";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

import { STAT_CARD_CONFIG } from "../../statCardConfig";
import type { ContributorStats } from "./types";

export interface ContributorStatsSectionProps {
  rows: ContributorStats[];
  authorColorMap: Map<string, string>;
  excludeRenames: boolean;
}

export function ContributorStatsSection({
  rows,
  authorColorMap,
  excludeRenames,
}: ContributorStatsSectionProps) {
  const { t } = useTranslation();

  const contributorColumns = useMemo<SettingsTableColumn<ContributorStats>[]>(
    () => [
      {
        key: "author",
        label: t("gitDashboard.author"),
        width: SETTINGS_TABLE_COL.fill,
        renderCell: (row) => (
          <span className="flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 shrink-0 rounded-full"
              style={{
                backgroundColor:
                  authorColorMap.get(row.name) ?? "var(--color-primary-6)",
              }}
            />
            <span className={`${SETTINGS_TABLE_CELL.primary} truncate`}>
              {row.name}
            </span>
          </span>
        ),
      },
      {
        key: "commits",
        label: t(STAT_CARD_CONFIG.commits.labelKey),
        width: "80px",
        align: "right",
        sorter: (rowA, rowB) => rowA.commitCount - rowB.commitCount,
        renderCell: (row) => (
          <span className={`${SETTINGS_TABLE_CELL.value} tabular-nums`}>
            {row.commitCount}
          </span>
        ),
      },
      {
        key: "files",
        label: t(STAT_CARD_CONFIG.filesChanged.labelKey),
        width: "80px",
        align: "right",
        sorter: (rowA, rowB) => {
          const metricsA = excludeRenames ? rowA.contentOnly : rowA.all;
          const metricsB = excludeRenames ? rowB.contentOnly : rowB.all;
          return metricsA.filesChanged - metricsB.filesChanged;
        },
        renderCell: (row) => {
          const metrics = excludeRenames ? row.contentOnly : row.all;
          return metrics.filesChanged > 0 ? (
            <span className={`${SETTINGS_TABLE_CELL.value} tabular-nums`}>
              {metrics.filesChanged}
            </span>
          ) : (
            <span className={SETTINGS_TABLE_CELL.muted}>—</span>
          );
        },
      },
      {
        key: "diff",
        label: t(STAT_CARD_CONFIG.linesChanged.labelKey),
        width: "200px",
        align: "right",
        sorter: (rowA, rowB) => {
          const metricsA = excludeRenames ? rowA.contentOnly : rowA.all;
          const metricsB = excludeRenames ? rowB.contentOnly : rowB.all;
          return (
            metricsA.additions +
            metricsA.deletions -
            (metricsB.additions + metricsB.deletions)
          );
        },
        renderCell: (row) => {
          const metrics = excludeRenames ? row.contentOnly : row.all;
          return metrics.additions > 0 || metrics.deletions > 0 ? (
            <DiffStatsBadge
              additions={metrics.additions}
              deletions={metrics.deletions}
              variant="plain"
              className="justify-end gap-x-3"
              formatValue={(value) => value.toLocaleString()}
            />
          ) : (
            <span className={SETTINGS_TABLE_CELL.muted}>—</span>
          );
        },
      },
      {
        key: "lastActive",
        label: t("gitDashboard.lastActive"),
        width: SETTINGS_TABLE_COL.valueMd,
        align: "right",
        sorter: (rowA, rowB) =>
          new Date(rowA.lastCommitDate).getTime() -
          new Date(rowB.lastCommitDate).getTime(),
        renderCell: (row) =>
          row.lastCommitDate ? (
            <span className={`${SETTINGS_TABLE_CELL.muted} whitespace-nowrap`}>
              {formatRelativeTime(row.lastCommitDate, "nano")}
            </span>
          ) : (
            <span className={SETTINGS_TABLE_CELL.muted}>—</span>
          ),
      },
    ],
    [t, authorColorMap, excludeRenames]
  );

  return (
    <CollapsibleSection title={t("gitDashboard.contributors")}>
      <SettingsTable<ContributorStats>
        columns={contributorColumns}
        rows={rows}
        getRowKey={(row) => row.name}
        headerHeight="tall"
        pageSize={50}
        maxHeight="min(420px, calc(100vh - 280px))"
        className="[&_.table]:table-fixed"
      />
    </CollapsibleSection>
  );
}
