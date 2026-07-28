import { Cpu, HardDrive, MonitorCog, RefreshCw } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { detectLocalModelHardware } from "@src/api/tauri/perf/metrics";
import type { LocalModelHardwareSummary } from "@src/api/tauri/perf/types";
import Button from "@src/components/Button";
import InlineAlert from "@src/components/InlineAlert";
import SettingsTable, {
  SETTINGS_TABLE_CELL,
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
} from "@src/components/SettingsTable";
import { useRefreshSpin } from "@src/hooks/ui";
import {
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { normalizedIncludes } from "@src/util/search/fuzzy";

import {
  LOCAL_MODEL_FIT_LEVEL,
  LOCAL_MODEL_RUN_MODE,
  type LocalModelRecommendation,
  recommendLocalModels,
} from "./localModelCatalog";

const DASH = "—";

interface LocalModelHardwareRow {
  key: "system" | "cpu" | "memory" | "gpu";
  icon: LucideIcon;
  label: string;
  value: string;
}

function formatGb(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return DASH;
  return `${value.toFixed(1)} GB`;
}

function formatTokens(value: number): string {
  if (value >= 1000) return `${Math.round(value / 1000)}K`;
  return String(value);
}

function hardwareRows(
  hardware: LocalModelHardwareSummary
): LocalModelHardwareRow[] {
  return [
    {
      key: "system",
      icon: MonitorCog,
      label: `${hardware.os_name} ${hardware.os_version}`,
      value: hardware.chip_type,
    },
    {
      key: "cpu",
      icon: Cpu,
      label: hardware.cpu_name,
      value: `${hardware.cpu_cores} cores`,
    },
    {
      key: "memory",
      icon: HardDrive,
      label: `${formatGb(hardware.available_ram_gb)} available`,
      value: `${formatGb(hardware.total_ram_gb)} total`,
    },
    {
      key: "gpu",
      icon: MonitorCog,
      label: hardware.has_gpu
        ? (hardware.gpu_name ?? DASH)
        : hardware.gpu_detection_status,
      value: hardware.has_gpu
        ? `${formatGb(hardware.gpu_vram_gb)} · ${hardware.backend}${hardware.unified_memory ? " · unified" : ""}`
        : (hardware.gpu_detection_message ?? hardware.backend),
    },
  ];
}

function fitLevelClass(fitLevel: LocalModelRecommendation["fitLevel"]): string {
  switch (fitLevel) {
    case LOCAL_MODEL_FIT_LEVEL.EXCELLENT:
      return "bg-success-1 text-success-6";
    case LOCAL_MODEL_FIT_LEVEL.GOOD:
      return "bg-primary-1 text-primary-6";
    case LOCAL_MODEL_FIT_LEVEL.TIGHT:
      return "bg-warning-1 text-warning-6";
    case LOCAL_MODEL_FIT_LEVEL.TOO_TIGHT:
      return "bg-danger-1 text-danger-6";
  }
}

function matchesRecommendation(
  entry: LocalModelRecommendation,
  query: string
): boolean {
  if (!query) return true;
  const fields = [
    entry.name,
    entry.provider,
    entry.family,
    entry.useCase,
    entry.ollamaModel ?? "",
    entry.ggufHint,
    entry.notes,
  ];
  return fields.some((field) => normalizedIncludes(field.toLowerCase(), query));
}

export default function LocalModelsTabSection() {
  const { t } = useTranslation("integrations");
  const [hardware, setHardware] = useState<LocalModelHardwareSummary | null>(
    null
  );
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const recommendations = useMemo(
    () => (hardware ? recommendLocalModels(hardware) : []),
    [hardware]
  );

  const filteredRecommendations = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return recommendations.filter((entry) =>
      matchesRecommendation(entry, query)
    );
  }, [recommendations, searchQuery]);

  const hardwareTableRows = useMemo(
    () => (hardware ? hardwareRows(hardware) : []),
    [hardware]
  );

  const handleDetect = async () => {
    setDetecting(true);
    setError(null);
    try {
      const detectedHardware = await detectLocalModelHardware();
      setHardware(detectedHardware);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDetecting(false);
    }
  };

  const { spinClass, handleClick } = useRefreshSpin(handleDetect, detecting);

  const detectButton = (
    <Button
      variant="secondary"
      size="default"
      onClick={() => void handleClick()}
      loading={detecting}
      loadingSpinIcon
      icon={<RefreshCw size={14} className={spinClass} />}
    >
      {t("localModels.detect")}
    </Button>
  );

  const hardwareColumns = useMemo<SettingsTableColumn<LocalModelHardwareRow>[]>(
    () => [
      {
        key: "hardware",
        label: t("localModels.columnHardware"),
        width: "180px",
        renderCell: (row) => {
          const Icon = row.icon;
          return (
            <span className={SETTINGS_TABLE_CELL.primaryIcon}>
              <Icon size={14} />
              {t(`localModels.hardware.${row.key}`)}
            </span>
          );
        },
      },
      {
        key: "details",
        label: t("localModels.columnDetails"),
        width: SETTINGS_TABLE_COL.fill,
        renderCell: (row) => (
          <span className={`${SETTINGS_TABLE_CELL.primary} truncate`}>
            {row.label}
          </span>
        ),
      },
      {
        key: "value",
        label: t("localModels.columnValue"),
        width: "220px",
        renderCell: (row) => (
          <span className={`${SETTINGS_TABLE_CELL.muted} truncate`}>
            {row.value}
          </span>
        ),
      },
    ],
    [t]
  );

  const recommendationColumns = useMemo<
    SettingsTableColumn<LocalModelRecommendation>[]
  >(
    () => [
      {
        key: "model",
        label: t("localModels.columnModel"),
        width: SETTINGS_TABLE_COL.fill,
        sorter: (rowA, rowB) => rowA.name.localeCompare(rowB.name),
        renderCell: (entry) => (
          <div className="flex min-w-0 flex-col gap-0.5">
            <span
              className={`${SETTINGS_TABLE_CELL.primary} truncate font-medium`}
            >
              {entry.name}
            </span>
            <span className={`${SETTINGS_TABLE_CELL.muted} truncate`}>
              {entry.provider} · {entry.family}
            </span>
          </div>
        ),
      },
      {
        key: "fit",
        label: t("localModels.columnFit"),
        width: "120px",
        sorter: (rowA, rowB) => rowA.score - rowB.score,
        renderCell: (entry) => (
          <span
            className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${fitLevelClass(entry.fitLevel)}`}
          >
            {t(`localModels.fit.${entry.fitLevel}`)}
          </span>
        ),
      },
      {
        key: "runMode",
        label: t("localModels.columnRunMode"),
        width: "130px",
        renderCell: (entry) => (
          <span className={SETTINGS_TABLE_CELL.primary}>
            {t(`localModels.runMode.${entry.runMode}`)}
          </span>
        ),
      },
      {
        key: "memory",
        label: t("localModels.columnMemory"),
        width: "120px",
        align: "right",
        sorter: (rowA, rowB) => rowA.requiredGb - rowB.requiredGb,
        renderCell: (entry) => (
          <span className="tabular-nums text-text-1">
            {formatGb(entry.requiredGb)}
          </span>
        ),
      },
      {
        key: "speed",
        label: t("localModels.columnSpeed"),
        width: "110px",
        align: "right",
        sorter: (rowA, rowB) => rowA.speedTps - rowB.speedTps,
        renderCell: (entry) => (
          <span className="tabular-nums text-text-1">
            {entry.runMode === LOCAL_MODEL_RUN_MODE.NO_FIT
              ? DASH
              : t("localModels.tokensPerSecond", { count: entry.speedTps })}
          </span>
        ),
      },
      {
        key: "context",
        label: t("localModels.columnContext"),
        width: "100px",
        align: "right",
        sorter: (rowA, rowB) => rowA.contextTokens - rowB.contextTokens,
        renderCell: (entry) => (
          <span className="tabular-nums text-text-1">
            {formatTokens(entry.contextTokens)}
          </span>
        ),
      },
      {
        key: "install",
        label: t("localModels.columnInstall"),
        width: "220px",
        renderCell: (entry) => (
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className={`${SETTINGS_TABLE_CELL.primary} truncate`}>
              {entry.ollamaModel ?? entry.ggufHint}
            </span>
            <span className={`${SETTINGS_TABLE_CELL.muted} truncate`}>
              {entry.notes}
            </span>
          </div>
        ),
      },
    ],
    [t]
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <SectionContainer>
        <SectionRow
          label={t("localModels.title")}
          description={t("localModels.description")}
        >
          {detectButton}
        </SectionRow>
      </SectionContainer>

      {error ? (
        <InlineAlert type="danger" title={t("localModels.detectFailed")}>
          {error}
        </InlineAlert>
      ) : null}

      <SettingsTable<LocalModelHardwareRow>
        hover
        columns={hardwareColumns}
        rows={hardwareTableRows}
        getRowKey={(row) => row.key}
        headerHeight="tall"
        emptyTitle={t("localModels.emptyTitle")}
        emptySubtitle={t("localModels.emptyDescription")}
      />

      <SettingsTable<LocalModelRecommendation>
        hover
        columns={recommendationColumns}
        rows={filteredRecommendations}
        getRowKey={(entry) => entry.id}
        headerHeight="tall"
        pageSize={20}
        searchBar={{
          searchValue: searchQuery,
          onSearchChange: setSearchQuery,
          searchPlaceholder: t("localModels.searchPlaceholder"),
          allowSearchClear: true,
        }}
        emptyTitle={
          hardware
            ? t("localModels.noMatchingRecommendations")
            : t("localModels.noRecommendations")
        }
        emptySubtitle={hardware ? undefined : t("localModels.emptyDescription")}
      />
    </div>
  );
}
