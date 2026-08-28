/**
 * Sync tab — last-sync clock plus manual trigger (leading, since that is what
 * a user opens this tab for), then per-repo session coverage for the org, then
 * per-org connection health, then the local sync journal ("bug logs").
 *
 * Presentational by design: every value arrives through `status`
 * (`useCloudOrgSyncStatus`), matching how `CloudOrgSettingsSection` consumes
 * `OrgRuntimeTelemetryState`. Nothing here talks to the backend.
 *
 * SECRETS: the connection block reports the backend KIND (managed vs custom)
 * and the signed-in user id only. The endpoint URL is not even exposed by the
 * status hook, and the Supabase anon key and access/refresh tokens are never
 * passed in, rendered, or copied.
 */
import type { TFunction } from "i18next";
import React, { useCallback, useMemo, useState } from "react";

import Avatar from "@src/components/Avatar";
import AvatarChip from "@src/components/AvatarChip";
import Button from "@src/components/Button";
import Select from "@src/components/Select";
import type { CloudCapabilities } from "@src/features/Org2Cloud/org2CloudCapabilities";
import type { RepoSyncCoverage } from "@src/features/Org2Cloud/org2CloudSyncCoverage";
import type {
  SyncJournalEntry,
  SyncJournalMember,
} from "@src/features/Org2Cloud/org2CloudSyncJournal";
import { useCopyCheck } from "@src/hooks/ui/useCopyCheck";
import { HugeiconsIcon, UsersRoundIcon } from "@src/icons";
import {
  SECTION_ACTION_GAP_CLASSES,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { copyText } from "@src/util/data/clipboard";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

import type { CloudOrgSyncStatus } from "./useCloudOrgSyncStatus";

/** Newest slice actually rendered; the buffer itself holds up to 100. */
const RENDERED_LOG_LIMIT = 50;
const ALL_MEMBERS_FILTER_VALUE = "all";
const MEMBER_FILTER_VALUE_PREFIX = "member:";

const CAPABILITY_KEYS = [
  "broadcastSignals",
  "storageSegments",
  "homeEndpoints",
  "teamInboxMentions",
  "memberRuntime",
] as const satisfies readonly (keyof CloudCapabilities)[];

const LEVEL_CLASSES: Record<SyncJournalEntry["level"], string> = {
  info: "bg-fill-2 text-text-3",
  warn: "bg-warning-6/15 text-warning-6",
  error: "bg-danger-6/15 text-danger-6",
};

const LEVEL_LABEL_KEYS: Record<SyncJournalEntry["level"], string> = {
  info: "cloud.orgPanel.sync.levelInfo",
  warn: "cloud.orgPanel.sync.levelWarn",
  error: "cloud.orgPanel.sync.levelError",
};

/**
 * Coverage bar fill. Floored to a visible sliver whenever ANYTHING is synced:
 * a large repo makes the first few sessions round to 0%, and an empty bar
 * beside a non-zero synced count reads as "nothing published".
 */
function coverageBarWidth(row: RepoSyncCoverage): string {
  return `${row.synced > 0 ? Math.max(row.percent, 2) : 0}%`;
}

interface CoverageRowProps {
  t: TFunction<"navigation">;
  row: RepoSyncCoverage;
}

/** One repo, one row: the org scope left, synced/total + meter + % right. */
function CoverageRow({ t, row }: CoverageRowProps) {
  return (
    <SectionRow
      dataTestId="cloud-org-sync-coverage-repo"
      label={
        // Matches how CloudOrgRepoScopesSection renders the same strings.
        <span className="min-w-0 truncate" title={row.repoScope}>
          {row.repoScope}
        </span>
      }
      truncateLabel
    >
      <div className="flex items-center justify-end gap-2.5">
        <span
          className="text-[12px] tabular-nums text-text-3"
          data-testid="cloud-org-sync-coverage-repo-count"
        >
          {`${row.synced.toLocaleString()}/${row.syncable.toLocaleString()}`}
        </span>
        <div
          className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-fill-2"
          role="progressbar"
          aria-valuenow={row.percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={t("cloud.orgPanel.sync.coveragePercentLabel")}
        >
          <div
            className="h-full rounded-full bg-success-6 transition-[width] duration-300"
            style={{ width: coverageBarWidth(row) }}
          />
        </div>
        <span
          className="w-9 shrink-0 text-right text-[12px] font-medium tabular-nums text-text-2"
          data-testid="cloud-org-sync-coverage-repo-percent"
        >
          {`${row.percent}%`}
        </span>
      </div>
    </SectionRow>
  );
}

/** Expiry is a wall-clock comparison, so it stays out of the render body. */
function isExpired(atMs: number | null): boolean {
  return atMs !== null && atMs <= Date.now();
}

function formatAbsolute(atMs: number | null): string {
  if (atMs === null) return "";
  try {
    return new Date(atMs).toLocaleString();
  } catch {
    return "";
  }
}

function memberDisplayName(member: SyncJournalMember): string {
  return member.displayName?.trim() || member.userId;
}

function memberInitial(member: SyncJournalMember): string {
  return memberDisplayName(member).slice(0, 1).toLocaleUpperCase();
}

function memberFilterValue(userId: string): string {
  return `${MEMBER_FILTER_VALUE_PREFIX}${userId}`;
}

interface SyncLogMemberOption {
  userId: string;
  displayName: string;
}

/** Newest label wins when a profile name changes within the local buffer. */
function buildSyncLogMemberOptions(
  entries: readonly SyncJournalEntry[]
): SyncLogMemberOption[] {
  const byUserId = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.member || byUserId.has(entry.member.userId)) continue;
    byUserId.set(entry.member.userId, memberDisplayName(entry.member));
  }
  return [...byUserId].map(([userId, displayName]) => ({
    userId,
    displayName,
  }));
}

function SyncLogMemberPill({ member }: { member: SyncJournalMember }) {
  const displayName = memberDisplayName(member);
  const identityLabel =
    displayName === member.userId
      ? member.userId
      : `${displayName} (${member.userId})`;
  return (
    <span
      className="inline-flex max-w-full shrink-0"
      title={identityLabel}
      aria-label={identityLabel}
      data-testid="cloud-org-sync-log-member"
    >
      <AvatarChip
        size="xs"
        avatarSize={14}
        avatarFallback={memberInitial(member)}
        label={displayName}
        labelClassName="max-w-36"
      />
    </span>
  );
}

/** Plain-text rendering of the journal, for the copy button. */
export function formatSyncJournalForCopy(
  entries: readonly SyncJournalEntry[]
): string {
  return entries
    .map((entry) => {
      const parts = [
        formatAbsolute(entry.atMs),
        entry.level.toUpperCase(),
        entry.kind,
      ];
      if (entry.orgId) parts.push(entry.orgId);
      if (entry.member) {
        const displayName = memberDisplayName(entry.member);
        parts.push(
          displayName === entry.member.userId
            ? `member ${entry.member.userId}`
            : `member ${displayName} (${entry.member.userId})`
        );
      }
      if (entry.code) parts.push(entry.code);
      return `[${parts.join(" | ")}] ${entry.message}`;
    })
    .join("\n");
}

interface CloudOrgSyncSectionProps {
  t: TFunction<"navigation">;
  status: CloudOrgSyncStatus;
}

/** Sync-tab connection, last-sync, manual trigger, and journal blocks. */
export function CloudOrgSyncSection({ t, status }: CloudOrgSyncSectionProps) {
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);
  const memberOptions = useMemo(
    () => buildSyncLogMemberOptions(status.entries),
    [status.entries]
  );
  const effectiveMemberId =
    selectedMemberId !== null &&
    memberOptions.some((option) => option.userId === selectedMemberId)
      ? selectedMemberId
      : null;
  const visibleEntries = useMemo(
    () =>
      (effectiveMemberId === null
        ? status.entries
        : status.entries.filter(
            (entry) => entry.member?.userId === effectiveMemberId
          )
      ).slice(0, RENDERED_LOG_LIMIT),
    [effectiveMemberId, status.entries]
  );
  const memberFilterOptions = useMemo(
    () => [
      {
        value: ALL_MEMBERS_FILTER_VALUE,
        label: t("cloud.sidebar.everyone"),
        icon: (
          <HugeiconsIcon
            icon={UsersRoundIcon}
            data-icon="users-round"
            size={14}
          />
        ),
        dataTestId: "cloud-org-sync-logs-member-all",
      },
      ...memberOptions.map((member) => ({
        value: memberFilterValue(member.userId),
        label: member.displayName,
        icon: (
          <Avatar size={14}>
            <span aria-hidden>{member.displayName.slice(0, 1)}</span>
          </Avatar>
        ),
        dataTestId: `cloud-org-sync-logs-member-${member.userId}`,
      })),
    ],
    [memberOptions, t]
  );

  const copyLog = useCallback(async () => {
    await copyText(formatSyncJournalForCopy(visibleEntries));
  }, [visibleEntries]);
  const { copied, handleCopy } = useCopyCheck(copyLog);

  const schemaLabel =
    status.schemaStatus === "checking"
      ? t("cloud.orgPanel.sync.schemaChecking")
      : status.schemaStatus === "matched"
        ? t("cloud.orgPanel.sync.schemaMatched", {
            version: status.expectedSchemaVersion,
          })
        : status.schemaStatus === "mismatched"
          ? t("cloud.orgPanel.sync.schemaMismatch", {
              backend: status.backendSchemaVersion,
              expected: status.expectedSchemaVersion,
            })
          : t("cloud.orgPanel.sync.schemaUnknown");

  const tokenExpiresAtMs = status.tokenExpiresAtMs;
  const tokenExpired = isExpired(tokenExpiresAtMs);
  const lastSuccessAtMs = status.lastSync.lastSuccessAtMs;
  const coverage = status.coverage;
  const coverageTitle =
    status.coverageLoading ||
    status.coverageUnavailable ||
    coverage.percent === null
      ? t("cloud.orgPanel.sync.coverageTitle")
      : `${t("cloud.orgPanel.sync.coverageTitle")} · ${t(
          "cloud.orgPanel.sync.coverageSummary",
          {
            synced: coverage.synced.toLocaleString(),
            syncable: coverage.syncable.toLocaleString(),
            percent: coverage.percent,
          }
        )}`;

  return (
    <>
      <SectionContainer title={t("cloud.orgPanel.sync.lastSyncTitle")}>
        <SectionRow
          dataTestId="cloud-org-sync-last"
          label={t("cloud.orgPanel.sync.lastSyncLabel")}
        >
          {lastSuccessAtMs === null ? (
            <span
              className="text-[12px] text-text-3"
              data-testid="cloud-org-sync-last-never"
            >
              {t("cloud.orgPanel.sync.lastSyncNever")}
            </span>
          ) : (
            <span
              className="text-[12px] text-text-2"
              data-testid="cloud-org-sync-last-value"
            >
              {`${formatRelativeTime(lastSuccessAtMs, "long")} · ${formatAbsolute(lastSuccessAtMs)}`}
            </span>
          )}
        </SectionRow>
        {status.lastSync.lastPassAtMs !== null &&
        status.lastSync.lastPassAtMs !== lastSuccessAtMs ? (
          <SectionRow
            dataTestId="cloud-org-sync-last-attempt"
            label={t("cloud.orgPanel.sync.lastAttemptLabel")}
          >
            <span className="text-[12px] text-text-3">
              {`${formatRelativeTime(status.lastSync.lastPassAtMs, "long")} · ${formatAbsolute(status.lastSync.lastPassAtMs)}`}
            </span>
          </SectionRow>
        ) : null}
        <SectionRow
          dataTestId="cloud-org-sync-manual"
          label={t("cloud.orgPanel.sync.manualLabel")}
          align="start"
        >
          {/* Outcome note LEADS the button: the row is right-aligned, so the
          button stays pinned to the edge and the note grows leftward instead
          of pushing it around as the text changes. */}
          <div className={`${SECTION_ACTION_GAP_CLASSES} flex-wrap`}>
            {status.runError ? (
              <span
                className="text-[12px] text-danger-6"
                data-testid="cloud-org-sync-run-error"
              >
                {t("cloud.orgPanel.sync.manualError", {
                  message: status.runError,
                })}
              </span>
            ) : status.runSucceeded ? (
              <span
                className="text-[12px] text-success-6"
                data-testid="cloud-org-sync-run-success"
              >
                {t("cloud.orgPanel.sync.manualSuccess")}
              </span>
            ) : null}
            <Button
              htmlType="button"
              size="default"
              variant="primary"
              disabled={status.running}
              loading={status.running}
              data-testid="cloud-org-sync-run"
              onClick={status.runSync}
            >
              {status.running
                ? t("cloud.orgPanel.sync.manualRunning")
                : t("cloud.orgPanel.sync.manualAction")}
            </Button>
          </div>
        </SectionRow>
      </SectionContainer>

      {/* Totals ride in the title so the body stays strictly one row per
      repo — the whole-device number is context, not a competing row. */}
      <SectionContainer title={coverageTitle}>
        {status.coverageLoading ? (
          <SectionRow
            dataTestId="cloud-org-sync-coverage-loading"
            label={t("cloud.orgPanel.loading")}
            light
          />
        ) : status.coverageUnavailable ? (
          <SectionRow
            dataTestId="cloud-org-sync-coverage-unavailable"
            label={t("cloud.orgPanel.loadError")}
            light
          />
        ) : coverage.repos.length === 0 ? (
          <SectionRow
            dataTestId="cloud-org-sync-coverage-empty"
            label={t("cloud.orgPanel.sync.coverageEmpty")}
            light
          />
        ) : (
          coverage.repos.map((row) => (
            <CoverageRow key={row.repoScope} t={t} row={row} />
          ))
        )}
      </SectionContainer>

      <SectionContainer title={t("cloud.orgPanel.sync.connectionTitle")}>
        <SectionRow
          dataTestId="cloud-org-sync-endpoint"
          label={t("cloud.orgPanel.sync.endpointLabel")}
        >
          {/* Backend KIND only — the endpoint URL is never rendered. */}
          <span className="text-[12px] text-text-2">
            {status.isOfficialEndpoint
              ? t("cloud.orgPanel.sync.endpointOfficial")
              : t("cloud.orgPanel.sync.endpointCustom")}
          </span>
        </SectionRow>

        {status.signedIn ? (
          <>
            <SectionRow
              dataTestId="cloud-org-sync-account"
              label={t("cloud.orgPanel.sync.signedInLabel")}
            >
              <span className="break-all text-[12px] text-text-2">
                {status.userId}
              </span>
            </SectionRow>
            <SectionRow
              dataTestId="cloud-org-sync-token"
              label={t("cloud.orgPanel.sync.tokenExpiresLabel")}
            >
              <span
                className={`text-[12px] ${tokenExpired ? "text-danger-6" : "text-text-2"}`}
              >
                {tokenExpiresAtMs === null
                  ? t("cloud.orgPanel.sync.endpointUnknown")
                  : tokenExpired
                    ? t("cloud.orgPanel.sync.tokenExpired")
                    : `${formatRelativeTime(tokenExpiresAtMs, "long")} · ${formatAbsolute(tokenExpiresAtMs)}`}
              </span>
            </SectionRow>
          </>
        ) : (
          <SectionRow
            dataTestId="cloud-org-sync-signed-out"
            label={t("cloud.orgPanel.sync.signedOut")}
            description={t("cloud.orgPanel.sync.signedOutHint")}
            light
          />
        )}

        <SectionRow
          dataTestId="cloud-org-sync-schema"
          label={t("cloud.orgPanel.sync.schemaLabel")}
        >
          <span
            className={`text-[12px] ${
              status.schemaStatus === "mismatched"
                ? "text-danger-6"
                : status.schemaStatus === "matched"
                  ? "text-success-6"
                  : "text-text-3"
            }`}
            data-testid={`cloud-org-sync-schema-${status.schemaStatus}`}
          >
            {schemaLabel}
          </span>
        </SectionRow>

        <SectionRow
          dataTestId="cloud-org-sync-capabilities"
          label={t("cloud.orgPanel.sync.capabilitiesLabel")}
          align="start"
          layout="vertical"
        >
          {status.capabilities ? (
            <ul className="flex flex-col gap-1">
              {CAPABILITY_KEYS.map((key) => {
                const enabled = status.capabilities?.[key] === true;
                return (
                  <li
                    key={key}
                    className="flex items-center gap-2 text-[12px]"
                    data-testid={`cloud-org-sync-capability-${key}`}
                  >
                    <span
                      className={`inline-block h-1.5 w-1.5 rounded-full ${
                        enabled ? "bg-success-6" : "bg-fill-3"
                      }`}
                    />
                    <span className="text-text-2">
                      {t(`cloud.orgPanel.sync.capability.${key}`)}
                    </span>
                    <span
                      className={enabled ? "text-success-6" : "text-text-3"}
                    >
                      {enabled
                        ? t("cloud.orgPanel.sync.capabilityEnabled")
                        : t("cloud.orgPanel.sync.capabilityDisabled")}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <span className="text-[12px] text-text-3">
              {status.capabilitiesLoading
                ? t("cloud.orgPanel.sync.capabilitiesChecking")
                : t("cloud.orgPanel.sync.capabilitiesUnavailable")}
            </span>
          )}
        </SectionRow>
      </SectionContainer>

      <SectionContainer title={t("cloud.orgPanel.sync.logsTitle")}>
        <SectionRow
          dataTestId="cloud-org-sync-logs-actions"
          label={t("cloud.orgPanel.sync.logsHelp")}
          light
        >
          <div className={`${SECTION_ACTION_GAP_CLASSES} flex-wrap`}>
            {memberOptions.length > 0 ? (
              <div className="w-40 max-w-full">
                <Select
                  value={
                    effectiveMemberId === null
                      ? ALL_MEMBERS_FILTER_VALUE
                      : memberFilterValue(effectiveMemberId)
                  }
                  options={memberFilterOptions}
                  size="mini"
                  radius="pill"
                  showSearch={memberOptions.length > 8}
                  dropdownAlign="right"
                  dropdownMinWidth={180}
                  dataTestId="cloud-org-sync-logs-member-filter"
                  onChange={(value) => {
                    const nextValue = String(value);
                    setSelectedMemberId(
                      nextValue === ALL_MEMBERS_FILTER_VALUE
                        ? null
                        : nextValue.slice(MEMBER_FILTER_VALUE_PREFIX.length)
                    );
                  }}
                />
              </div>
            ) : null}
            <Button
              htmlType="button"
              size="default"
              variant="secondary"
              disabled={visibleEntries.length === 0}
              data-testid="cloud-org-sync-logs-copy"
              onClick={handleCopy}
            >
              {copied
                ? t("cloud.orgPanel.sync.logsCopied")
                : t("cloud.orgPanel.sync.logsCopy")}
            </Button>
            <Button
              htmlType="button"
              size="default"
              variant="secondary"
              disabled={status.entries.length === 0}
              data-testid="cloud-org-sync-logs-clear"
              onClick={status.clearLog}
            >
              {t("cloud.orgPanel.sync.logsClear")}
            </Button>
          </div>
        </SectionRow>

        {visibleEntries.length === 0 ? (
          <SectionRow
            dataTestId="cloud-org-sync-logs-empty"
            label={t("cloud.orgPanel.sync.logsEmpty")}
            light
          />
        ) : (
          <SectionRow
            dataTestId="cloud-org-sync-logs"
            layout="vertical"
            showHeader={false}
          >
            <ul className="flex flex-col gap-2">
              {visibleEntries.map((entry) => (
                <li
                  key={entry.id}
                  className="flex flex-col gap-1.5 rounded-lg border border-border-1 bg-bg-1 px-3 py-2.5"
                  data-testid="cloud-org-sync-log-entry"
                >
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                    <span
                      className={`rounded-full px-1.5 py-0.5 font-medium ${LEVEL_CLASSES[entry.level]}`}
                      data-testid={`cloud-org-sync-log-level-${entry.level}`}
                    >
                      {t(LEVEL_LABEL_KEYS[entry.level])}
                    </span>
                    <span className="text-text-3">
                      {formatAbsolute(entry.atMs)}
                    </span>
                    <span className="text-text-3">{entry.kind}</span>
                    {entry.orgId ? (
                      <span className="text-text-3">
                        {t("cloud.orgPanel.sync.logsOrg", {
                          orgId: entry.orgId,
                        })}
                      </span>
                    ) : null}
                    {entry.code ? (
                      <span className="rounded bg-fill-2 px-1.5 py-0.5 text-text-2">
                        {entry.code}
                      </span>
                    ) : null}
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-1 text-[12px] text-text-2">
                    {entry.member ? (
                      <>
                        <SyncLogMemberPill member={entry.member} />
                        <span aria-hidden className="text-text-3">
                          :
                        </span>
                      </>
                    ) : null}
                    <span className="min-w-0 break-words">{entry.message}</span>
                  </div>
                </li>
              ))}
            </ul>
          </SectionRow>
        )}
      </SectionContainer>
    </>
  );
}

export default CloudOrgSyncSection;
