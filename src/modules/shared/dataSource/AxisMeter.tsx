import { memo } from "react";
import { useTranslation } from "react-i18next";

import type { AxisEvidence, AxisScore } from "@src/api/tauri/builderProfile";
import SettingsTable, {
  SETTINGS_TABLE_CELL,
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
} from "@src/components/SettingsTable";
import { ExpandableTableRow } from "@src/modules/shared/layouts/SectionLayout";

/** Half the track: the meter is bipolar, so 0 sits at the midpoint. */
const HALF = 50;

interface AxisMeterProps {
  axis: AxisScore;
  expanded: boolean;
  onToggle: () => void;
}

/**
 * One axis as an expandable settings row: where you sit on the left, the
 * evidence table underneath.
 *
 * The evidence is the point. A typology that shows only a letter cannot be
 * argued with; showing each signal's own median beside the neutral value it was
 * compared to lets someone disagree for a concrete reason.
 */
const AxisMeter = memo(function AxisMeter({
  axis,
  expanded,
  onToggle,
}: AxisMeterProps) {
  const { t } = useTranslation("builderProfile");

  // The letter always stands; clarity decides how much weight it is drawn with.
  const soft = axis.clarity === "slight" || axis.clarity === "moderate";
  const positive = axis.score >= 0;
  const width = (Math.min(Math.abs(axis.score), 100) / 100) * HALF;

  const columns: SettingsTableColumn<AxisEvidence>[] = [
    {
      key: "signal",
      label: t("evidenceCol.signal"),
      width: SETTINGS_TABLE_COL.fill,
      renderCell: (row) => (
        <span className={SETTINGS_TABLE_CELL.primary}>
          {row.towardPositive ? "↑" : "↓"} {row.label}
        </span>
      ),
    },
    {
      key: "median",
      label: t("evidenceCol.yours"),
      width: SETTINGS_TABLE_COL.valueMd,
      align: "right",
      renderCell: (row) => (
        <span className={SETTINGS_TABLE_CELL.value}>
          {formatNumber(row.median)}
        </span>
      ),
    },
    {
      key: "anchor",
      label: t("evidenceCol.neutral"),
      width: SETTINGS_TABLE_COL.valueMd,
      align: "right",
      renderCell: (row) => (
        <span className={SETTINGS_TABLE_CELL.muted}>
          {formatNumber(row.anchor)}
        </span>
      ),
    },
  ];

  return (
    <ExpandableTableRow
      label={`${axis.negativeName} · ${axis.positiveName}`}
      description={
        axis.caveat
          ? `${axis.question} — ${t("caveat", { reason: axis.caveat })}`
          : axis.question
      }
      expanded={expanded}
      onToggle={onToggle}
      extraControls={
        <div
          className="flex items-center gap-2"
          data-testid={`axis-${axis.key}`}
        >
          <span className="relative h-1.5 w-24 rounded-full bg-fill-3">
            <span className="absolute inset-y-0 left-1/2 w-px bg-border-2" />
            <span
              className={`absolute inset-y-0 rounded-full ${
                soft ? "bg-fill-4" : "bg-primary-6"
              }`}
              style={
                positive
                  ? { left: `${HALF}%`, width: `${width}%` }
                  : { right: `${HALF}%`, width: `${width}%` }
              }
            />
          </span>
          <span
            className={`w-4 text-center font-mono text-sm ${
              soft ? "text-text-3" : "text-text-1"
            }`}
            title={t(`clarity.${axis.clarity}`)}
          >
            {axis.letter}
          </span>
        </div>
      }
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between text-xs text-text-3">
          <span>
            {t("axisStats", {
              sessions: axis.sessions,
              consistency: Math.round(axis.consistency * 100),
            })}
          </span>
          <span>
            {axis.flipFactor === null
              ? t("anchorNeverFlips")
              : t("anchorFlip", { factor: axis.flipFactor.toFixed(2) })}
          </span>
        </div>
        <SettingsTable
          columns={columns}
          rows={axis.evidence}
          getRowKey={(row) => row.signal}
          headerHeight="compact"
          dense
          surfaceVariant="transparent"
        />
        <p className="text-xs text-text-3">{t("evidenceHint")}</p>
      </div>
    </ExpandableTableRow>
  );
});

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  if (Math.abs(value) >= 10) return value.toFixed(0);
  if (Math.abs(value) >= 1) return value.toFixed(1);
  return value.toFixed(2);
}

export default AxisMeter;
