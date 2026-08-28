/**
 * One teammate in the Runtime → Team roster grid: identity, builder type,
 * live machine load, today / 7d usage headline, installed-agent icons, and a
 * staleness line. The whole card opens the member drilldown.
 */
import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";

import Avatar from "@src/components/Avatar";
import ModelIcon, { type IconProvider } from "@src/components/ModelIcon";
import type {
  MemberInstalledAgent,
  MemberRuntimeListEntry,
  OrgRuntimeTelemetry,
} from "@src/features/Org2Cloud/memberRuntime/types";
import { ComputerTerminal01Icon, HugeiconsIcon } from "@src/icons";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

import BuilderTypeAvatar from "./BuilderTypeAvatar";
import { getBuilderType } from "./builderTypes";
import {
  foldRecentDays,
  formatMemGb,
  isInstalledAgentPresent,
  isRuntimeStale,
} from "./teamRuntimeData";
import { formatInt, formatTokensShort, formatUsd } from "./usageFormat";

/** Display metadata resolved from the local detection catalog. */
export interface AgentCatalogEntry {
  displayName: string;
  iconId: string;
}

export type AgentCatalog = ReadonlyMap<string, AgentCatalogEntry>;

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border-1 bg-fill-1 px-2 py-0.5 text-[11px] text-text-2">
      {children}
    </span>
  );
}

export function AgentIcon({
  agent,
  catalog,
}: {
  agent: MemberInstalledAgent;
  catalog: AgentCatalog;
}) {
  const known = catalog.get(agent.id);
  if (!known) {
    // Unknown provider id (newer peer app): the raw id still identifies it.
    return (
      <span
        className="rounded bg-fill-2 px-1.5 py-0.5 font-mono text-[10px] text-text-3"
        data-testid={`team-agent-${agent.id}`}
      >
        {agent.id}
      </span>
    );
  }
  return (
    <span
      title={known.displayName}
      className="inline-flex items-center"
      data-testid={`team-agent-${agent.id}`}
    >
      <ModelIcon
        provider={known.iconId as IconProvider}
        size={16}
        fallback={
          <HugeiconsIcon
            icon={ComputerTerminal01Icon}
            data-icon="terminal"
            size={16}
            className="text-text-3"
          />
        }
      />
    </span>
  );
}

interface TeamMemberCardProps {
  entry: MemberRuntimeListEntry;
  telemetry: OrgRuntimeTelemetry | null;
  nowMs: number;
  agentCatalog: AgentCatalog;
  isSelf: boolean;
  /** Takes the userId rather than being pre-bound per card, so the parent can
   * pass one stable callback reference to every card instead of a fresh
   * closure per render (which would defeat this component's `memo`). */
  onOpen: (userId: string) => void;
}

const TeamMemberCard = memo(function TeamMemberCard({
  entry,
  telemetry,
  nowMs,
  agentCatalog,
  isSelf,
  onOpen,
}: TeamMemberCardProps) {
  const { t } = useTranslation("teamRuntime");
  const displayName = entry.displayName ?? entry.userId;
  const builderType = getBuilderType(
    entry.builderTypeCode ?? entry.profile?.code
  );
  const stale = isRuntimeStale(entry.reportedAt, telemetry, nowMs);
  const headline = useMemo(
    () => foldRecentDays(entry.recentDays, nowMs),
    [entry.recentDays, nowMs]
  );
  const agents = useMemo(
    () => entry.installedAgents.filter(isInstalledAgentPresent),
    [entry.installedAgents]
  );
  const sample = entry.sample;
  const machine = entry.machine;

  return (
    <button
      type="button"
      onClick={() => onOpen(entry.userId)}
      data-testid={`team-member-card-${entry.userId}`}
      data-stale={stale ? "true" : "false"}
      className="flex w-full flex-col gap-3 rounded-xl border border-border-1 bg-primary-container p-4 text-left transition-colors hover:border-border-2"
    >
      <div className="flex items-center gap-3">
        <Avatar size={36} src={entry.avatarUrl ?? undefined}>
          {displayName.slice(0, 1).toUpperCase()}
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-text-1">
              {displayName}
            </span>
            {isSelf ? (
              <span className="shrink-0 rounded-full bg-fill-2 px-1.5 py-0.5 text-[10px] text-text-3">
                {t("card.you")}
              </span>
            ) : null}
          </div>
          <div className="truncate text-xs text-text-3">{entry.role}</div>
        </div>
        {builderType ? (
          <div
            className="flex shrink-0 items-center gap-2"
            data-testid={`team-member-type-${entry.userId}`}
          >
            <div className="text-right">
              <div className="font-mono text-xs text-text-1">
                {builderType.code}
              </div>
              <div className="text-[10px] text-text-3">{builderType.name}</div>
            </div>
            <BuilderTypeAvatar
              type={builderType}
              className="h-9 w-9 rounded-lg"
            />
          </div>
        ) : null}
      </div>

      {sample ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip>
            {t("card.cpu")} {Math.round(sample.cpuPercent)}%
          </Chip>
          <Chip>
            {t("card.ram")} {formatMemGb(sample.memUsedMb)}/
            {formatMemGb(sample.memTotalMb)} GB
          </Chip>
          {machine?.gpuName ? (
            <Chip>
              {machine.gpuName}
              {sample.gpuPercent != null
                ? ` ${Math.round(sample.gpuPercent)}%`
                : ""}
            </Chip>
          ) : sample.gpuPercent != null ? (
            <Chip>
              {t("card.gpu")} {Math.round(sample.gpuPercent)}%
            </Chip>
          ) : null}
        </div>
      ) : null}

      {machine ? (
        <div className="truncate text-[11px] text-text-3">
          {machine.machineLabel} · {machine.chipType} · ORGII{" "}
          {machine.appVersion}
        </div>
      ) : null}

      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
        <span data-testid={`team-member-today-${entry.userId}`}>
          <span className="text-text-3">{t("card.today")} </span>
          <span className="font-medium text-text-1">
            {formatUsd(headline.todayCostUsd, 2)}
          </span>{" "}
          <span className="text-text-3">
            {formatTokensShort(headline.todayTokens)}
          </span>
        </span>
        <span data-testid={`team-member-week-${entry.userId}`}>
          <span className="text-text-3">{t("card.week")} </span>
          <span className="font-medium text-text-1">
            {formatUsd(headline.weekCostUsd, 2)}
          </span>{" "}
          <span className="text-text-3">
            {formatTokensShort(headline.weekTokens)}
          </span>
        </span>
        {entry.stats ? (
          <span data-testid={`team-member-sessions-${entry.userId}`}>
            <span className="text-text-3">{t("card.sessions")} </span>
            <span className="font-medium text-text-1">
              {formatInt(entry.stats.totalSessions)}
            </span>
          </span>
        ) : null}
      </div>

      {agents.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {agents.map((agent) => (
            <AgentIcon key={agent.id} agent={agent} catalog={agentCatalog} />
          ))}
        </div>
      ) : null}

      <div
        className="text-[11px] text-text-3"
        data-testid={`team-member-synced-${entry.userId}`}
      >
        {entry.reportedAt
          ? t("card.lastSynced", {
              time: formatRelativeTime(entry.reportedAt, "long"),
            })
          : t("card.neverReported")}
      </div>
    </button>
  );
});

export default TeamMemberCard;
