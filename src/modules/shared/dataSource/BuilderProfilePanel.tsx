import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  type BuilderProfileOverview,
  type DriftPoint,
  type ProfileCoverage,
  type SourceProfile,
  builderProfileExtract,
  builderProfileOverview,
} from "@src/api/tauri/builderProfile";
import Button from "@src/components/Button";
import ProgressBar from "@src/components/ProgressBar";
import SettingsTable, {
  SETTINGS_TABLE_CELL,
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
} from "@src/components/SettingsTable";
import Tooltip from "@src/components/Tooltip";
import { useRefreshSpin } from "@src/hooks/ui";
import {
  SECTION_GAP_CLASSES,
  SECTION_SUBHEADING_CLASSES,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { Placeholder } from "@src/modules/shared/layouts/blocks";

import AxisMeter from "./AxisMeter";
import HighlightCards from "./HighlightCards";

/** Delay between background extraction batches while the panel is open. */
const EXTRACT_TICK_MS = 1_200;
/**
 * Full re-score cadence during the drain, in batches. Every batch changes the
 * corpus fingerprint, so each reload is a full uncached scoring pass — doing
 * that per batch would keep a core busy for the whole drain. The bar still
 * moves every batch, from the coverage carried on the extract response.
 */
const RELOAD_EVERY_BATCHES = 5;

/**
 * Chat pane → Runtime → Profile: how you work with coding agents, measured from
 * your own sessions.
 *
 * Two behaviours worth knowing about when reading this:
 *
 * - Signals are extracted lazily. On first open there is nothing cached, so the
 *   panel drives `builder_profile_extract` in bounded batches and re-scores at
 *   milestones as coverage grows, instead of blocking on tens of thousands of
 *   transcripts. The progress bar is that backlog draining.
 * - Every axis always yields its letter. A soft one — split sessions, or a
 *   verdict that hinges on the anchor — renders dimmed with its caveat in the
 *   tooltip, never replaced by a placeholder.
 */
export default function BuilderProfilePanel() {
  const { t } = useTranslation("sessions", {
    keyPrefix: "kanban.dataSource.profile",
  });
  const [data, setData] = useState<BuilderProfileOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [extracting, setExtracting] = useState(false);
  // Fresher than data.coverage between the throttled full reloads.
  const [liveCoverage, setLiveCoverage] = useState<ProfileCoverage | null>(
    null
  );
  const [openAxis, setOpenAxis] = useState<string | null>(null);

  // Tauri invokes are not abortable; a monotonic counter keeps a stale response
  // from overwriting a newer one.
  const requestRef = useRef(0);
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      requestRef.current += 1;
    };
  }, []);

  const load = useCallback(async () => {
    const seq = (requestRef.current += 1);
    try {
      const next = await builderProfileOverview({}, true);
      if (seq === requestRef.current && aliveRef.current) {
        setData(next);
        setError(null);
      }
    } catch (err) {
      if (seq === requestRef.current && aliveRef.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (seq === requestRef.current && aliveRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Drain the extraction backlog while the panel is open. The bar advances on
  // every batch; the profile itself re-scores at milestones and once at the
  // end, because each uncached scoring pass is a dozen-plus full profiles.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let batches = 0;
    const tick = async () => {
      if (cancelled || !aliveRef.current) return;
      try {
        const progress = await builderProfileExtract();
        if (cancelled || !aliveRef.current) return;
        setExtracting(progress.more);
        setLiveCoverage(progress.coverage);
        if (progress.extractedNow > 0) {
          batches += 1;
          if (batches % RELOAD_EVERY_BATCHES === 0) await load();
          timer = setTimeout(() => void tick(), EXTRACT_TICK_MS);
        } else if (batches > 0) {
          // Backlog drained: one final re-score picks up everything since the
          // last milestone.
          await load();
        }
      } catch {
        setExtracting(false); // extraction is best-effort; scoring still works
      }
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  const onRefresh = useCallback(() => {
    setLoading(true);
    void load();
  }, [load]);
  const { spinClass, handleClick: onRefreshClick } = useRefreshSpin(
    onRefresh,
    loading
  );

  const profile = data?.profile;
  const coverage = liveCoverage ?? data?.coverage;
  const percent = useMemo(() => {
    const known = coverage?.known ?? 0;
    if (known <= 0) return 100;
    return Math.min(
      100,
      Math.round(((coverage?.extracted ?? 0) / known) * 100)
    );
  }, [coverage]);
  const stillReading = extracting || percent < 100;

  const sourceColumns: SettingsTableColumn<SourceProfile>[] = useMemo(
    () => [
      {
        key: "source",
        label: t("byToolCol.tool"),
        width: SETTINGS_TABLE_COL.fill,
        renderCell: (row) => (
          <span className={SETTINGS_TABLE_CELL.primary}>{row.source}</span>
        ),
      },
      {
        key: "code",
        label: t("byToolCol.code"),
        width: SETTINGS_TABLE_COL.valueSm,
        renderCell: (row) => (
          <span className={`${SETTINGS_TABLE_CELL.value} font-mono`}>
            {row.code}
          </span>
        ),
      },
      {
        key: "sessions",
        label: t("byToolCol.sessions"),
        width: SETTINGS_TABLE_COL.valueMd,
        align: "right",
        renderCell: (row) => (
          <span className={SETTINGS_TABLE_CELL.muted}>{row.sessions}</span>
        ),
      },
    ],
    [t]
  );

  const driftColumns: SettingsTableColumn<DriftPoint>[] = useMemo(
    () => [
      {
        key: "when",
        label: t("overTimeCol.window"),
        width: SETTINGS_TABLE_COL.fill,
        renderCell: (row) => (
          <span className={SETTINGS_TABLE_CELL.primary}>
            {new Date(row.endedAtMs).toLocaleDateString()}
          </span>
        ),
      },
      {
        key: "code",
        label: t("overTimeCol.code"),
        width: SETTINGS_TABLE_COL.valueSm,
        renderCell: (row) => (
          <span className={`${SETTINGS_TABLE_CELL.value} font-mono`}>
            {row.code}
          </span>
        ),
      },
      {
        key: "sessions",
        label: t("overTimeCol.sessions"),
        width: SETTINGS_TABLE_COL.valueMd,
        align: "right",
        renderCell: (row) => (
          <span className={SETTINGS_TABLE_CELL.muted}>{row.sessions}</span>
        ),
      },
    ],
    [t]
  );

  if (loading && !data) return <Placeholder variant="loading" />;
  if (error && !data)
    return (
      <Placeholder variant="error" placement="detail-panel" title={error} />
    );
  if (!profile) return <Placeholder variant="empty" />;

  const letters = profile.code.split("");

  return (
    <div className={SECTION_GAP_CLASSES} data-testid="builder-profile-panel">
      <div className="flex items-center justify-between gap-2">
        <h2 className={SECTION_SUBHEADING_CLASSES}>{t("title")}</h2>
        <Button
          variant="tertiary"
          size="small"
          onClick={onRefreshClick}
          data-testid="builder-profile-refresh"
          icon={<RefreshCw className={`h-3.5 w-3.5 ${spinClass ?? ""}`} />}
        >
          {t("refresh")}
        </Button>
      </div>

      {/* The code. Soft letters render dimmed, with the reason in the tooltip.
          Before any session has been read there is no evidence at all, so no
          letters — a default code would present as a confident type. */}
      <div className="flex flex-col items-center gap-2 rounded-lg bg-bg-2 px-4 py-6">
        {profile.sessions === 0 ? (
          <div
            className="py-2 text-sm text-text-3"
            data-testid="builder-profile-empty-code"
          >
            {t("noSessionsYet")}
          </div>
        ) : (
          <>
            <div
              className="flex items-end gap-1"
              data-testid="builder-profile-code"
            >
              {letters.map((letter, i) => {
                const axis = profile.axes[i];
                // Every letter is real; a soft one is dimmed, never replaced.
                const soft =
                  axis?.clarity === "slight" || axis?.clarity === "moderate";
                return (
                  <Tooltip
                    key={axis?.key ?? i}
                    content={[
                      `${axis?.negativeName} · ${axis?.positiveName}`,
                      axis ? t(`clarity.${axis.clarity}`) : "",
                      axis?.caveat ?? "",
                    ]
                      .filter(Boolean)
                      .join(" — ")}
                  >
                    <span
                      className={`font-mono text-4xl leading-none ${
                        soft ? "text-text-3" : "text-text-1"
                      }`}
                    >
                      {letter}
                    </span>
                  </Tooltip>
                );
              })}
            </div>
            <div className="text-sm text-text-2">{profile.archetype}</div>
            <div className="text-xs text-text-3">
              {t("summaryLine", { sessions: profile.sessions })}
            </div>
            {!profile.hasEnoughSessions && (
              <div className="text-xs text-warning-5">
                {t("tooFewSessions")}
              </div>
            )}
          </>
        )}
      </div>

      <SectionContainer title={t("highlights")}>
        <SectionRow description={t("highlightsHint")} layout="vertical">
          <HighlightCards highlights={data.highlights} />
        </SectionRow>
      </SectionContainer>

      <SectionContainer title={t("status")}>
        <SectionRow
          label={t("coverage")}
          description={
            stillReading ? t("coverageReading") : t("coverageComplete")
          }
        >
          <div
            className="flex w-44 items-center gap-2"
            data-testid="builder-profile-coverage"
          >
            <ProgressBar percent={percent} animated={stillReading} />
            <span className="w-10 shrink-0 text-right text-xs text-text-3">
              {percent}%
            </span>
          </div>
        </SectionRow>
        <SectionRow label={t("confidence")} description={t("confidenceHint")}>
          <div className="flex w-44 items-center gap-2">
            <ProgressBar percent={Math.round(profile.confidence * 100)} />
            <span className="w-10 shrink-0 text-right text-xs text-text-3">
              {Math.round(profile.confidence * 100)}%
            </span>
          </div>
        </SectionRow>
      </SectionContainer>

      <SectionContainer title={t("axesTitle")}>
        {profile.axes.map((axis) => (
          <AxisMeter
            key={axis.key}
            axis={axis}
            expanded={openAxis === axis.key}
            onToggle={() =>
              setOpenAxis((cur) => (cur === axis.key ? null : axis.key))
            }
          />
        ))}
      </SectionContainer>

      {profile.secondary.length > 0 && (
        <SectionContainer title={t("secondary")}>
          {profile.secondary.map((axis) => (
            <SectionRow
              key={axis.key}
              label={axis.score >= 0 ? axis.positiveName : axis.negativeName}
              description={t("secondaryNote")}
            />
          ))}
          <SectionRow label={t("fanoutLabel")} description={t("fanoutHint")}>
            <span className="text-xs text-text-3">
              {Math.round(profile.subagentSessionShare * 100)}%
            </span>
          </SectionRow>
        </SectionContainer>
      )}

      {data.bySource.length > 1 && (
        <SectionContainer title={t("byTool")}>
          <SectionRow description={t("byToolHint")} layout="vertical">
            <SettingsTable
              columns={sourceColumns}
              rows={data.bySource}
              getRowKey={(row) => row.source}
              headerHeight="compact"
              dense
              surfaceVariant="transparent"
            />
          </SectionRow>
        </SectionContainer>
      )}

      {data.drift.length > 1 && (
        <SectionContainer title={t("overTime")}>
          <SectionRow description={t("overTimeHint")} layout="vertical">
            <SettingsTable
              columns={driftColumns}
              rows={data.drift}
              getRowKey={(row) => String(row.endedAtMs)}
              headerHeight="compact"
              dense
              surfaceVariant="transparent"
            />
          </SectionRow>
        </SectionContainer>
      )}
    </div>
  );
}
