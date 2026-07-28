import { RefreshCw } from "lucide-react";
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import {
  CONTAINER_ENGINE_KIND,
  type ContainerEngineCandidate,
} from "@src/api/tauri/container";
import Button from "@src/components/Button";
import SettingsTable, {
  SETTINGS_TABLE_CELL,
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
} from "@src/components/SettingsTable";
import { useRefreshSpin } from "@src/hooks/ui";
import {
  CollapsibleSection,
  DETAIL_PANEL_TOKENS,
  Placeholder,
} from "@src/modules/shared/layouts/blocks";

interface ContainerEnginesSectionProps {
  engines: ContainerEngineCandidate[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onOpenChange?: (open: boolean) => void;
  defaultOpen?: boolean;
  compact?: boolean;
}

const KIND_LABEL_KEY = {
  [CONTAINER_ENGINE_KIND.LOCAL]:
    "navigation:launchpad.containerEngines.kinds.local",
  [CONTAINER_ENGINE_KIND.SSH]:
    "navigation:launchpad.containerEngines.kinds.ssh",
  [CONTAINER_ENGINE_KIND.WSL]:
    "navigation:launchpad.containerEngines.kinds.wsl",
} as const;

const ContainerEnginesSection: React.FC<ContainerEnginesSectionProps> = ({
  engines,
  loading,
  error,
  onRefresh,
  onOpenChange,
  defaultOpen = false,
  compact = false,
}) => {
  const { t } = useTranslation(["navigation", "common"]);
  const { spinClass, handleClick: handleRefreshClick } = useRefreshSpin(
    onRefresh,
    loading
  );

  const columns = useMemo<SettingsTableColumn<ContainerEngineCandidate>[]>(
    () => [
      {
        key: "name",
        label: t("navigation:launchpad.containerEngines.name"),
        width: SETTINGS_TABLE_COL.fill,
        renderCell: (row) => (
          <div className="min-w-0">
            <div className="truncate text-text-1">
              {row.label}
              {row.current ? (
                <span className="ml-2 rounded bg-primary-2 px-1.5 py-0.5 text-[10px] font-medium text-primary-6">
                  {t("navigation:launchpad.containerEngines.current")}
                </span>
              ) : null}
            </div>
            <div className={SETTINGS_TABLE_CELL.subtitle}>
              {row.endpoint ?? "—"}
            </div>
          </div>
        ),
      },
      {
        key: "kind",
        label: t("navigation:launchpad.containerEngines.kind"),
        width: SETTINGS_TABLE_COL.valueSm,
        renderCell: (row) => (
          <span className={SETTINGS_TABLE_CELL.value}>
            {t(KIND_LABEL_KEY[row.kind])}
          </span>
        ),
      },
      {
        key: "status",
        label: t("navigation:launchpad.containerEngines.status"),
        width: SETTINGS_TABLE_COL.valueSm,
        renderCell: (row) => (
          <span className={SETTINGS_TABLE_CELL.statusRow}>
            <span
              className={`h-2 w-2 rounded-full ${row.available ? "bg-success-6" : "bg-warning-6"}`}
            />
            <span className={SETTINGS_TABLE_CELL.value}>
              {row.available
                ? t("navigation:launchpad.containerEngines.available")
                : t("navigation:launchpad.containerEngines.unavailable")}
            </span>
          </span>
        ),
      },
      {
        key: "detail",
        label: t("navigation:launchpad.containerEngines.detail"),
        width: SETTINGS_TABLE_COL.valueLg,
        hideBelow: "md",
        renderCell: (row) => (
          <span className={`${SETTINGS_TABLE_CELL.muted} block truncate`}>
            {row.detail ?? "—"}
          </span>
        ),
      },
    ],
    [t]
  );

  return (
    <CollapsibleSection
      title={
        engines.length > 0
          ? `${t("navigation:launchpad.containerEngines.title")} (${engines.length})`
          : t("navigation:launchpad.containerEngines.title")
      }
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
      compact={compact}
      actions={
        <Button
          variant="tertiary"
          size="mini"
          icon={<RefreshCw size={13} className={spinClass} />}
          onClick={handleRefreshClick}
          aria-label={t("common:actions.refresh")}
        />
      }
    >
      {error ? (
        <div className={DETAIL_PANEL_TOKENS.primaryContainer}>
          <Placeholder
            variant="error"
            title={t("navigation:launchpad.containerEngines.errorTitle")}
            subtitle={error}
            action={{
              label: t("common:actions.refresh"),
              onClick: onRefresh,
            }}
          />
        </div>
      ) : loading ? (
        <div className={DETAIL_PANEL_TOKENS.primaryContainer}>
          <Placeholder variant="loading" />
        </div>
      ) : engines.length === 0 ? (
        <div className={DETAIL_PANEL_TOKENS.primaryContainer}>
          <Placeholder
            variant="empty"
            title={t("navigation:launchpad.containerEngines.emptyTitle")}
            subtitle={t("navigation:launchpad.containerEngines.emptySubtitle")}
          />
        </div>
      ) : (
        <SettingsTable<ContainerEngineCandidate>
          columns={columns}
          rows={engines}
          getRowKey={(row) => row.id}
          headerHeight="compact"
          emptyTitle={t("navigation:launchpad.containerEngines.emptyTitle")}
        />
      )}
    </CollapsibleSection>
  );
};

export default ContainerEnginesSection;
