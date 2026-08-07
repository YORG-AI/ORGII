/**
 * DataSourceDetailsCard
 *
 * Reusable inline detail card shown when a Data Sources row is expanded.
 * Surfaces the on-disk store path(s) — with Copy / Open-folder actions — and
 * the imported session count. Composed from the same primitives the KeyVault
 * "keys" inline cards use (`InlineInfoCard` + `INFO_CARD_TOKENS`), so the two
 * expanded-row surfaces read identically.
 */
import { Copy, FolderOpen } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import type {
  ExternalCliSourceProbe,
  ExternalSourceStats,
} from "@src/api/tauri/externalHistory";
import Button from "@src/components/Button";
import { INFO_CARD_TOKENS } from "@src/config/detailPanelTokens";
import InlineInfoCard from "@src/modules/shared/layouts/blocks/InlineInfoCard";
import { copyText } from "@src/util/data/clipboard";

import { storeKindLabel, tildePath } from "./sourcePath";

export interface DataSourceDetailsCardProps {
  probe: ExternalCliSourceProbe;
  stats: ExternalSourceStats | null;
  /** Reveal the given path in the OS file manager. */
  onOpenFolder: (path: string) => void;
  /** Copy the given path to the clipboard. Defaults to the shared `copyText`. */
  onCopyPath?: (path: string) => void;
}

const DataSourceDetailsCard: React.FC<DataSourceDetailsCardProps> = ({
  probe,
  stats,
  onOpenFolder,
  onCopyPath,
}) => {
  const { t } = useTranslation("sessions", { keyPrefix: "kanban.dataSource" });
  const paths = probe.historyPaths;
  const kindLabel = storeKindLabel(probe);
  const handleCopy = onCopyPath ?? ((path: string) => void copyText(path));

  return (
    <InlineInfoCard>
      <div className={`grid ${INFO_CARD_TOKENS.rowGap}`}>
        {/* Store path(s) — with Copy + Open-folder actions per path. */}
        <div className="flex items-start justify-between gap-3">
          <span className={`${INFO_CARD_TOKENS.label} pt-1`}>
            {t("details.path")}
          </span>
          {paths.length > 0 ? (
            <div className="flex min-w-0 flex-col items-end gap-1">
              {paths.map((path) => (
                <div
                  key={path}
                  className="flex min-w-0 max-w-full items-center gap-1.5"
                >
                  <span
                    className="min-w-0 truncate text-[12px] text-text-1"
                    title={path}
                  >
                    {tildePath(path)}
                  </span>
                  <Button
                    variant="secondary"
                    size="small"
                    iconOnly
                    icon={<Copy size={13} />}
                    title={t("details.copyPath")}
                    onClick={() => handleCopy(path)}
                  />
                  <Button
                    variant="secondary"
                    size="small"
                    iconOnly
                    icon={<FolderOpen size={13} />}
                    title={t("openFolder")}
                    onClick={() => onOpenFolder(path)}
                  />
                </div>
              ))}
            </div>
          ) : (
            <span className={INFO_CARD_TOKENS.value}>{t("noPath")}</span>
          )}
        </div>

        {/* Store format (JSONL / SQLite / …). */}
        {kindLabel ? (
          <div className={INFO_CARD_TOKENS.row}>
            <span className={INFO_CARD_TOKENS.label}>
              {t("details.storeType")}
            </span>
            <span className={INFO_CARD_TOKENS.value}>{kindLabel}</span>
          </div>
        ) : null}

        {/* Imported session count. */}
        <div className={INFO_CARD_TOKENS.row}>
          <span className={INFO_CARD_TOKENS.label}>{t("col.sessions")}</span>
          <span className={`${INFO_CARD_TOKENS.value} tabular-nums`}>
            {stats?.sessionCount ?? 0}
          </span>
        </div>

        {/* Hidden sub-agent sessions (Cursor sub-agent composers; omitted when
            the source has none). */}
        {stats && stats.subagentCount > 0 ? (
          <div className={INFO_CARD_TOKENS.row}>
            <span className={INFO_CARD_TOKENS.label}>Subagents</span>
            <span className={`${INFO_CARD_TOKENS.value} tabular-nums`}>
              {stats.subagentCount}
            </span>
          </div>
        ) : null}
      </div>
    </InlineInfoCard>
  );
};

export default DataSourceDetailsCard;
