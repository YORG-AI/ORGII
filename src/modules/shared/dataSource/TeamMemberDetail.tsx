/**
 * Runtime → Team drilldown for one member: builder-profile card (axes +
 * confidence, reusing `AxisMeter` and the type-gallery card surface), a usage
 * range fetched via `getMemberUsage` and folded into the existing chart /
 * stat-card props, installed agents with labels, and machine details.
 *
 * Rendered as a second layer over the roster (the `BuilderTypesPanel`
 * back-button idiom of this folder).
 */
import { ChevronLeft, Terminal } from "lucide-react";
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import Avatar from "@src/components/Avatar";
import Button from "@src/components/Button";
import ModelIcon, { type IconProvider } from "@src/components/ModelIcon";
import ProgressBar from "@src/components/ProgressBar";
import Select from "@src/components/Select";
import TabPill, { type TabPillItem } from "@src/components/TabPill";
import { getMemberUsage } from "@src/features/Org2Cloud/memberRuntime/memberRuntimeClient";
import type {
  MemberRuntimeListEntry,
  MemberUsageDay,
  TeamUsageBucket,
} from "@src/features/Org2Cloud/memberRuntime/types";
import { TEAM_USAGE_BUCKETS } from "@src/features/Org2Cloud/memberRuntime/types";
import {
  SECTION_SUBHEADING_CLASSES,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

import AxisMeter from "./AxisMeter";
import BuilderTypeAvatar from "./BuilderTypeAvatar";
import { type AgentCatalog } from "./TeamMemberCard";
import UsageStatCards from "./UsageStatCards";
import { getBuilderType } from "./builderTypes";
import {
  foldMemberUsageSummary,
  isInstalledAgentPresent,
  memberUsageDayRange,
  memberUsageDaysToTrendPoints,
  utcDayStartMs,
} from "./teamRuntimeData";
import { bucketLabelKey } from "./usageBuckets";
import { formatInt } from "./usageFormat";

const SOURCE_ALL = "all";
const UsageTrendChart = lazy(() => import("./UsageTrendChart"));

const RANGE_OPTIONS = [7, 30, 90] as const;
type MemberUsageRangeDays = (typeof RANGE_OPTIONS)[number];

interface TeamMemberDetailProps {
  entry: MemberRuntimeListEntry;
  orgId: string;
  getFreshAccessToken: () => Promise<string>;
  agentCatalog: AgentCatalog;
  language: string;
  onBack: () => void;
}

export default function TeamMemberDetail({
  entry,
  orgId,
  getFreshAccessToken,
  agentCatalog,
  language,
  onBack,
}: TeamMemberDetailProps) {
  const { t } = useTranslation("teamRuntime");
  const { t: tUsage } = useTranslation("sessions", {
    keyPrefix: "kanban.dataSource",
  });

  const [rangeDays, setRangeDays] = useState<MemberUsageRangeDays>(30);
  const [bucket, setBucket] = useState<TeamUsageBucket | null>(null);
  const [days, setDays] = useState<MemberUsageDay[] | null>(null);
  const [range, setRange] = useState<{ fromDay: string; toDay: string } | null>(
    null
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const [openAxis, setOpenAxis] = useState<string | null>(null);

  const requestRef = useRef(0);
  useEffect(
    () => () => {
      requestRef.current += 1;
    },
    []
  );

  useEffect(() => {
    let cancelled = false;
    const seq = ++requestRef.current;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const accessToken = await getFreshAccessToken();
        const nextRange = memberUsageDayRange(Date.now(), rangeDays);
        const rows = await getMemberUsage(
          accessToken,
          orgId,
          entry.userId,
          nextRange.fromDay,
          nextRange.toDay
        );
        if (cancelled || seq !== requestRef.current) return;
        setDays(rows);
        setRange(nextRange);
      } catch (err) {
        if (!cancelled && seq === requestRef.current) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled && seq === requestRef.current) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [entry.userId, orgId, rangeDays, retryNonce, getFreshAccessToken]);

  const summary = useMemo(
    () => (days ? foldMemberUsageSummary(days, bucket) : null),
    [days, bucket]
  );
  const trendPoints = useMemo(
    () => (days ? memberUsageDaysToTrendPoints(days, bucket) : []),
    [days, bucket]
  );
  const chartStartMs = range ? utcDayStartMs(range.fromDay) : null;
  const chartEndMs = range ? utcDayStartMs(range.toDay) : null;

  const bucketTabs = useMemo<TabPillItem[]>(
    () => [
      { key: SOURCE_ALL, label: tUsage("usage.allSources") },
      ...TEAM_USAGE_BUCKETS.map((source) => ({
        key: source,
        label: tUsage(bucketLabelKey(source)),
      })),
    ],
    [tUsage]
  );
  const rangeOptions = useMemo(
    () =>
      RANGE_OPTIONS.map((preset) => ({
        value: String(preset),
        label: t(`detail.range.${preset}`),
      })),
    [t]
  );

  const displayName = entry.displayName ?? entry.userId;
  const builderType = getBuilderType(
    entry.builderTypeCode ?? entry.profile?.code
  );
  const profile = entry.profile;
  const agents = entry.installedAgents.filter(isInstalledAgentPresent);
  const machine = entry.machine;

  return (
    <div className="flex flex-col gap-4" data-testid="team-member-detail">
      <div className="flex items-center justify-between gap-2">
        <Button
          variant="tertiary"
          size="small"
          onClick={onBack}
          icon={<ChevronLeft className="h-3.5 w-3.5" />}
          data-testid="team-member-back"
        >
          {t("detail.back")}
        </Button>
      </div>

      <div className="flex items-center gap-3">
        <Avatar size={40} src={entry.avatarUrl ?? undefined}>
          {displayName.slice(0, 1).toUpperCase()}
        </Avatar>
        <div className="min-w-0">
          <div className="truncate text-base font-semibold text-text-1">
            {displayName}
          </div>
          <div className="truncate text-xs text-text-3">
            {entry.role}
            {machine ? ` · ${machine.machineLabel}` : ""}
          </div>
        </div>
      </div>

      <h3 className={SECTION_SUBHEADING_CLASSES}>{t("detail.profileTitle")}</h3>
      {profile && builderType ? (
        <>
          <section
            className="rounded-xl border border-border-1 bg-primary-container p-4"
            data-testid="team-member-profile"
          >
            <div className="flex items-center gap-4">
              <BuilderTypeAvatar
                type={builderType}
                eager
                className="h-24 w-24 rounded-xl"
              />
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-center gap-2">
                  <span
                    className="font-mono text-2xl text-text-1"
                    data-testid="team-member-profile-code"
                  >
                    {builderType.code}
                  </span>
                </div>
                <h4 className="text-lg font-semibold text-text-1">
                  {builderType.name}
                </h4>
                <div className="mt-2 flex w-44 items-center gap-2">
                  <ProgressBar percent={Math.round(profile.confidence * 100)} />
                  <span className="w-10 shrink-0 text-right text-xs text-text-3">
                    {Math.round(profile.confidence * 100)}%
                  </span>
                </div>
              </div>
            </div>
          </section>
          {profile.axes.length > 0 ? (
            <SectionContainer>
              {profile.axes.map((axis) => (
                <AxisMeter
                  key={axis.key}
                  axis={axis}
                  expanded={openAxis === axis.key}
                  onToggle={() =>
                    setOpenAxis((current) =>
                      current === axis.key ? null : axis.key
                    )
                  }
                />
              ))}
            </SectionContainer>
          ) : null}
        </>
      ) : (
        <div
          className="rounded-lg bg-bg-2 px-4 py-8 text-center text-sm text-text-3"
          data-testid="team-member-no-profile"
        >
          {t("detail.noProfile")}
        </div>
      )}

      <div className="flex min-h-9 flex-wrap items-center justify-between gap-2">
        <h3 className={SECTION_SUBHEADING_CLASSES}>{t("detail.usageTitle")}</h3>
        <div className="flex min-w-0 items-center gap-2">
          <TabPill
            activeTab={bucket ?? SOURCE_ALL}
            tabs={bucketTabs}
            onChange={(key) =>
              setBucket(key === SOURCE_ALL ? null : (key as TeamUsageBucket))
            }
            variant="pill"
            size="mini"
            colorScheme="ghost"
            fillWidth={false}
          />
          <span
            aria-hidden
            className="pointer-events-none h-4 w-px shrink-0 bg-border-2"
          />
          <Select
            value={String(rangeDays)}
            onChange={(value) =>
              setRangeDays(
                Number.parseInt(String(value), 10) as MemberUsageRangeDays
              )
            }
            options={rangeOptions}
            variant="ghost"
            size="small"
          />
        </div>
      </div>

      {error ? (
        <Placeholder
          variant="error"
          placement="detail-panel"
          title={t("loadError")}
          subtitle={error}
          onRetry={() => setRetryNonce((nonce) => nonce + 1)}
        />
      ) : loading || !summary ? (
        <Placeholder variant="loading" placement="detail-panel" />
      ) : days && days.length === 0 ? (
        <Placeholder
          variant="empty"
          placement="detail-panel"
          title={t("detail.usageEmpty")}
        />
      ) : (
        <>
          <UsageStatCards summary={summary} language={language} />
          <Suspense
            fallback={
              <Placeholder variant="loading" placement="detail-panel" />
            }
          >
            <UsageTrendChart
              points={trendPoints}
              hourly={false}
              startMs={chartStartMs}
              endMs={chartEndMs}
              dataEndMs={chartEndMs}
              language={language}
            />
          </Suspense>
        </>
      )}

      {agents.length > 0 ? (
        <>
          <h3 className={SECTION_SUBHEADING_CLASSES}>
            {t("detail.agentsTitle")}
          </h3>
          <div
            className="flex flex-wrap gap-2"
            data-testid="team-member-agents"
          >
            {agents.map((agent) => {
              const known = agentCatalog.get(agent.id);
              return (
                <span
                  key={agent.id}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border-1 bg-fill-1 px-2.5 py-1 text-xs text-text-2"
                >
                  {known ? (
                    <ModelIcon
                      provider={known.iconId as IconProvider}
                      size={14}
                      fallback={<Terminal size={14} className="text-text-3" />}
                    />
                  ) : (
                    <Terminal size={14} className="text-text-3" />
                  )}
                  {known?.displayName ?? agent.id}
                </span>
              );
            })}
          </div>
        </>
      ) : null}

      {machine || entry.reportedAt || entry.stats ? (
        <>
          <h3 className={SECTION_SUBHEADING_CLASSES}>
            {t("detail.machineTitle")}
          </h3>
          <SectionContainer>
            {machine ? (
              <>
                <SectionRow label={t("detail.machineLabel")}>
                  <span className="text-xs text-text-2">
                    {machine.machineLabel}
                  </span>
                </SectionRow>
                <SectionRow label={t("detail.os")}>
                  <span className="text-xs text-text-2">
                    {machine.osName} {machine.osVersion}
                  </span>
                </SectionRow>
                <SectionRow label={t("detail.chip")}>
                  <span className="text-xs text-text-2">
                    {machine.chipType}
                    {machine.cpuCores ? ` · ${machine.cpuCores}c` : ""}
                  </span>
                </SectionRow>
                {machine.totalRamGb ? (
                  <SectionRow label={t("detail.memory")}>
                    <span className="text-xs text-text-2">
                      {machine.totalRamGb} GB
                      {machine.unifiedMemory ? ` · ${t("detail.unified")}` : ""}
                    </span>
                  </SectionRow>
                ) : null}
                {machine.gpuName ? (
                  <SectionRow label={t("detail.gpu")}>
                    <span className="text-xs text-text-2">
                      {machine.gpuName}
                      {machine.gpuVramGb ? ` · ${machine.gpuVramGb} GB` : ""}
                    </span>
                  </SectionRow>
                ) : null}
                <SectionRow label={t("detail.appVersion")}>
                  <span className="text-xs text-text-2">
                    {machine.appVersion}
                  </span>
                </SectionRow>
              </>
            ) : null}
            {entry.stats ? (
              <SectionRow label={t("detail.totalSessions")}>
                <span
                  className="text-xs text-text-2"
                  data-testid="team-detail-total-sessions"
                >
                  {formatInt(entry.stats.totalSessions)}
                </span>
              </SectionRow>
            ) : null}
            <SectionRow label={t("detail.lastSynced")}>
              <span
                className="text-xs text-text-2"
                data-testid="team-detail-last-synced"
              >
                {entry.reportedAt
                  ? formatRelativeTime(entry.reportedAt, "long")
                  : t("card.neverReported")}
              </span>
            </SectionRow>
          </SectionContainer>
        </>
      ) : null}
    </div>
  );
}
