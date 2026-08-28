/**
 * Runtime → organization → Today's analytical surface.
 *
 * Headlines are folded from the roster's inline UTC-day aggregates; the
 * rolling chart and member breakdown use its bounded `stats.recentUsage24h`
 * snapshot. Recent sessions are a read-only projection of the existing Team
 * Sessions cache, so this component owns no network request, timer,
 * subscription, or cache.
 */
import { type ReactNode, Suspense, lazy, memo, useMemo } from "react";
import { useTranslation } from "react-i18next";

import Avatar from "@src/components/Avatar";
import Select from "@src/components/Select";
import type {
  MemberRuntimeListEntry,
  OrgRuntimeTelemetry,
} from "@src/features/Org2Cloud/memberRuntime/types";
import { MEMBER_RECENT_USAGE_WINDOW_MS } from "@src/features/Org2Cloud/memberRuntime/types";
import type { CloudRemoteSessionsFetchState } from "@src/features/Org2Cloud/org2CloudRemoteSessionsAtom";
import { HugeiconsIcon, Message02Icon } from "@src/icons";
import {
  SECTION_SUBHEADING_CLASSES,
  SectionContainer,
} from "@src/modules/shared/layouts/SectionLayout";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

import {
  aggregateMemberRecentUsageTrends,
  buildOrgRuntimeTodaySnapshot,
  recentSharedSessions,
} from "./teamRuntimeData";
import { BucketIcon, bucketLabelKey } from "./usageBuckets";
import {
  formatInt,
  formatPercent,
  formatTokensShort,
  formatUsd,
} from "./usageFormat";

const ALL_MEMBERS = "all";
const RECENT_SESSION_LIMIT = 5;
const UsageTrendChart = lazy(() => import("./UsageTrendChart"));

interface TodayMetricProps {
  label: string;
  value: string;
  secondary?: string;
  testId: string;
}

function TodayMetric({ label, value, secondary, testId }: TodayMetricProps) {
  return (
    <div
      className="flex min-w-0 flex-col gap-1.5 rounded-xl border border-border-1 bg-primary-container p-4"
      data-testid={testId}
    >
      <span className="truncate text-xs text-text-2">{label}</span>
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="truncate text-xl font-semibold text-text-1">
          {value}
        </span>
        {secondary ? (
          <span className="truncate text-xs font-medium text-text-3">
            {secondary}
          </span>
        ) : null}
      </div>
    </div>
  );
}

interface TeamRuntimeTodayProps {
  members: readonly MemberRuntimeListEntry[];
  telemetry: OrgRuntimeTelemetry | null;
  nowMs: number;
  language: string;
  selectedMemberId: string | null;
  onSelectMember: (userId: string | null) => void;
  sessionRows: readonly RemoteTeammateSessionMetadata[];
  sessionState: CloudRemoteSessionsFetchState;
  onOpenSession: (row: RemoteTeammateSessionMetadata) => void;
  headerAction?: ReactNode;
}

function TeamRuntimeToday({
  members,
  telemetry,
  nowMs,
  language,
  selectedMemberId,
  onSelectMember,
  sessionRows,
  sessionState,
  onOpenSession,
  headerAction,
}: TeamRuntimeTodayProps) {
  const { t } = useTranslation("teamRuntime");
  const { t: tUsage } = useTranslation("sessions", {
    keyPrefix: "kanban.dataSource",
  });

  const scopedMembers = useMemo(
    () =>
      selectedMemberId === null
        ? members
        : members.filter((member) => member.userId === selectedMemberId),
    [members, selectedMemberId]
  );
  const snapshot = useMemo(
    () => buildOrgRuntimeTodaySnapshot(scopedMembers, telemetry, nowMs),
    [scopedMembers, telemetry, nowMs]
  );
  const latestSessions = useMemo(
    () =>
      recentSharedSessions(sessionRows, selectedMemberId, RECENT_SESSION_LIMIT),
    [sessionRows, selectedMemberId]
  );
  const memberOptions = useMemo(
    () => [
      {
        value: ALL_MEMBERS,
        label: t("overview.everyone"),
        dataTestId: "team-runtime-person-all",
      },
      ...members.map((member) => ({
        value: member.userId,
        label: member.displayName ?? member.userId,
        dataTestId: `team-runtime-person-${member.userId}`,
      })),
    ],
    [members, t]
  );
  const sourceMix = useMemo(
    () =>
      [...snapshot.usage.byBucket].sort(
        (left, right) => right.realTotalTokens - left.realTotalTokens
      ),
    [snapshot.usage.byBucket]
  );
  const usageStartMs = nowMs - MEMBER_RECENT_USAGE_WINDOW_MS;
  const usageTrendPoints = useMemo(
    () => aggregateMemberRecentUsageTrends(scopedMembers, usageStartMs, nowMs),
    [scopedMembers, usageStartMs, nowMs]
  );
  const memberUsage = useMemo(
    () =>
      members
        .map((member) => ({
          member,
          summary: member.stats?.recentUsage24h?.summary ?? null,
        }))
        .sort((left, right) => {
          const tokenDelta =
            (right.summary?.realTotalTokens ?? 0) -
            (left.summary?.realTotalTokens ?? 0);
          if (tokenDelta !== 0) return tokenDelta;
          return (left.member.displayName ?? left.member.userId).localeCompare(
            right.member.displayName ?? right.member.userId
          );
        }),
    [members]
  );

  const systemSecondary = [
    snapshot.averageCpuPercent == null
      ? null
      : `${t("card.cpu")} ${Math.round(snapshot.averageCpuPercent)}%`,
    snapshot.averageRamPercent == null
      ? null
      : `${t("card.ram")} ${Math.round(snapshot.averageRamPercent)}%`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex flex-col gap-5" data-testid="team-runtime-today">
      <div
        className="flex min-h-9 flex-wrap items-center justify-between gap-3"
        data-testid="team-runtime-title-row"
      >
        <h3 className={SECTION_SUBHEADING_CLASSES}>{t("overview.today")}</h3>
        {members.length > 0 || headerAction ? (
          <div className="flex min-w-0 items-center gap-2">
            {members.length > 0 ? (
              <Select
                value={selectedMemberId ?? ALL_MEMBERS}
                options={memberOptions}
                onChange={(value) =>
                  onSelectMember(
                    String(value) === ALL_MEMBERS ? null : String(value)
                  )
                }
                appearance="ghost"
                size="small"
                dataTestId="team-runtime-person-select"
              />
            ) : null}
            {headerAction ? (
              <div
                className="flex shrink-0 items-center"
                data-testid="team-runtime-controls"
              >
                {headerAction}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-3 @[720px]:grid-cols-4">
        <TodayMetric
          label={tUsage("usage.cards.realTokens")}
          value={formatTokensShort(snapshot.usage.realTotalTokens)}
          testId="team-runtime-today-tokens"
        />
        <TodayMetric
          label={tUsage("usage.cards.cost")}
          value={formatUsd(snapshot.usage.costUsd, 2)}
          testId="team-runtime-today-cost"
        />
        <TodayMetric
          label={tUsage("usage.cards.sessions")}
          value={formatInt(snapshot.usage.sessionCount, language)}
          secondary={`${formatInt(
            snapshot.usage.requestCount,
            language
          )} ${tUsage("usage.cards.requests")}`}
          testId="team-runtime-today-sessions"
        />
        <TodayMetric
          label={t("overview.activeMembers")}
          value={`${formatInt(snapshot.activeMembers, language)}/${formatInt(
            snapshot.memberCount,
            language
          )}`}
          secondary={`${tUsage("usage.cards.cacheHit")} ${formatPercent(
            snapshot.usage.cacheHitRate
          )}`}
          testId="team-runtime-today-members"
        />
      </div>

      <div
        className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-border-1 bg-fill-1 px-3 py-2 text-xs text-text-3"
        data-testid="team-runtime-system-pulse"
      >
        <span className="font-medium text-text-2">
          {t("overview.systemsCurrent", {
            current: snapshot.currentSystems,
            total: snapshot.memberCount,
          })}
        </span>
        {systemSecondary ? <span>{systemSecondary}</span> : null}
      </div>

      <section
        className="flex min-w-0 flex-col gap-3"
        data-testid="team-runtime-usage-trend"
      >
        <div className="flex items-center justify-between gap-3">
          <h3 className={SECTION_SUBHEADING_CLASSES}>
            {tUsage("usage.trends.title")}
          </h3>
          <span className="shrink-0 text-xs text-text-3">
            {tUsage("usage.range.24h")}
          </span>
        </div>
        <Suspense
          fallback={<div aria-hidden className="h-72 rounded-xl bg-fill-1" />}
        >
          <UsageTrendChart
            points={usageTrendPoints}
            hourly
            startMs={usageStartMs}
            endMs={nowMs}
            dataEndMs={nowMs}
            language={language}
          />
        </Suspense>
      </section>

      <section
        className="flex min-w-0 flex-col gap-3"
        data-testid="team-runtime-member-usage"
      >
        <div className="flex items-center justify-between gap-3">
          <h3 className={SECTION_SUBHEADING_CLASSES}>
            {t("overview.members")}
          </h3>
          <span className="shrink-0 text-xs text-text-3">
            {tUsage("usage.range.24h")}
          </span>
        </div>
        <SectionContainer>
          {memberUsage.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-text-3">
              {t("detail.usageEmpty")}
            </div>
          ) : (
            memberUsage.map(({ member, summary }) => {
              const displayName = member.displayName ?? member.userId;
              const selected = selectedMemberId === member.userId;
              return (
                <button
                  key={member.userId}
                  type="button"
                  aria-pressed={selected}
                  onClick={() =>
                    onSelectMember(selected ? null : member.userId)
                  }
                  className={`flex w-full items-center gap-3 border-b border-border-1 px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-fill-1 ${
                    selected ? "bg-fill-1" : ""
                  }`}
                  data-testid={`team-runtime-member-usage-${member.userId}`}
                >
                  <Avatar size={28} src={member.avatarUrl ?? undefined}>
                    {displayName.slice(0, 1).toUpperCase()}
                  </Avatar>
                  <span className="min-w-0 flex-1 truncate text-sm text-text-2">
                    {displayName}
                  </span>
                  <span className="shrink-0 text-right text-xs text-text-3">
                    {summary ? (
                      <>
                        <span className="font-medium text-text-1">
                          {formatTokensShort(summary.realTotalTokens)}
                        </span>{" "}
                        · {formatUsd(summary.costUsd, 2)}
                      </>
                    ) : (
                      "—"
                    )}
                  </span>
                </button>
              );
            })
          )}
        </SectionContainer>
      </section>

      <div className="grid grid-cols-1 gap-4 @[720px]:grid-cols-2">
        <section className="flex min-w-0 flex-col gap-3">
          <h3 className={SECTION_SUBHEADING_CLASSES}>
            {t("overview.usageByAgent")}
          </h3>
          <SectionContainer>
            {sourceMix.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-text-3">
                {t("detail.usageEmpty")}
              </div>
            ) : (
              sourceMix.map((source) => (
                <div
                  key={source.bucket}
                  className="flex items-center justify-between gap-3 border-b border-border-1 px-4 py-3 last:border-b-0"
                  data-testid={`team-runtime-source-${source.bucket}`}
                >
                  <span className="flex min-w-0 items-center gap-2 text-sm text-text-2">
                    <BucketIcon
                      bucket={source.bucket}
                      size={16}
                      className="shrink-0"
                    />
                    <span className="truncate">
                      {tUsage(bucketLabelKey(source.bucket))}
                    </span>
                  </span>
                  <span className="shrink-0 text-right text-xs text-text-3">
                    <span className="font-medium text-text-1">
                      {formatTokensShort(source.realTotalTokens)}
                    </span>{" "}
                    · {formatUsd(source.costUsd, 2)}
                  </span>
                </div>
              ))
            )}
          </SectionContainer>
        </section>

        <section className="flex min-w-0 flex-col gap-3">
          <h3 className={SECTION_SUBHEADING_CLASSES}>
            {t("overview.recentSessions")}
          </h3>
          <SectionContainer>
            {latestSessions.length > 0 ? (
              latestSessions.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  onClick={() => onOpenSession(session)}
                  className="flex w-full items-center gap-3 border-b border-border-1 px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-fill-1"
                  data-testid={`team-runtime-recent-session-${session.id}`}
                >
                  <Avatar size={28} src={session.ownerAvatarUrl}>
                    {(session.ownerDisplayName || "?")
                      .slice(0, 1)
                      .toUpperCase()}
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-text-1">
                      {session.title || session.sourceSessionId}
                    </div>
                    <div className="truncate text-xs text-text-3">
                      {session.ownerDisplayName}
                      {session.agentDisplayName
                        ? ` · ${session.agentDisplayName}`
                        : ""}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5 text-[11px] text-text-3">
                    <HugeiconsIcon
                      icon={Message02Icon}
                      data-icon="message-square-text"
                      className="h-3.5 w-3.5"
                      aria-hidden
                    />
                    {session.lastActivityAt
                      ? formatRelativeTime(session.lastActivityAt, "nano")
                      : "—"}
                  </div>
                </button>
              ))
            ) : (
              <div className="px-4 py-8 text-center text-sm text-text-3">
                {sessionState === "loading" || sessionState === "idle"
                  ? t("overview.recentLoading")
                  : sessionState === "error"
                    ? t("loadError")
                    : t("overview.recentEmpty")}
              </div>
            )}
          </SectionContainer>
        </section>
      </div>
    </div>
  );
}

export default memo(TeamRuntimeToday);
