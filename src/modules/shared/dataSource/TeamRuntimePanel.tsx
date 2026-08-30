/**
 * Chat pane → Runtime → Team: teammates' shared runtime — machine load,
 * usage/cost headlines, builder type, installed agents — read from ORG2 Cloud
 * (`cloud_list_member_runtime`) for the selected cloud org.
 *
 * The panel is read-only: opting out of sharing lives in the privacy settings
 * (`privacy.shareRuntimeWithOrg`), not here.
 */
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { externalCliSourcesDetect } from "@src/api/tauri/externalHistory/detection";
import Button from "@src/components/Button";
import { Placeholder } from "@src/components/Placeholder";
import type {
  MemberRuntimeListEntry,
  OrgRuntimeTelemetry,
} from "@src/features/Org2Cloud/memberRuntime/types";
import { useCloudOrgRemoteSessions } from "@src/features/Org2Cloud/org2CloudRemoteSessionsAtom";
import { useOpenCloudSessionReference } from "@src/features/Org2Cloud/useOpenCloudSessionReference";
import { useOrg2CloudSignIn } from "@src/features/Org2Cloud/useOrg2CloudSignIn";
import { useRefreshSpin } from "@src/hooks/ui";
import { HugeiconsIcon, Refresh04Icon } from "@src/icons";
import {
  SECTION_GAP_CLASSES,
  SECTION_SUBHEADING_CLASSES,
} from "@src/modules/shared/layouts/SectionLayout";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

import TeamMemberCard, {
  type AgentCatalog,
  type AgentCatalogEntry,
} from "./TeamMemberCard";
import TeamMemberDetail from "./TeamMemberDetail";
import TeamRuntimeToday from "./TeamRuntimeToday";
import { useTeamRuntimeClock } from "./teamRuntimeClock";
import { hasMemberActivityToday } from "./teamRuntimeData";
import { useTeamRuntimeRoster } from "./useTeamRuntimeRoster";

const EMPTY_AGENT_CATALOG: AgentCatalog = new Map<string, AgentCatalogEntry>();

/**
 * Installed-agent ids are stable provider ids; display names and icons come
 * from the local detection catalog (entries exist for every provider
 * regardless of local install status). The probe starts only when a ready
 * roster has member cards to render, never while signed out/disabled/empty.
 */
function useAgentCatalog(enabled: boolean): AgentCatalog {
  const [catalog, setCatalog] = useState<AgentCatalog>(EMPTY_AGENT_CATALOG);
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    void externalCliSourcesDetect()
      .then((probes) => {
        if (cancelled) return;
        setCatalog(
          new Map(
            probes.map((probe) => [
              probe.sourceId,
              { displayName: probe.displayName, iconId: probe.iconId },
            ])
          )
        );
      })
      .catch(() => {
        // Catalog resolution is cosmetic; raw provider ids still render.
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return enabled ? catalog : EMPTY_AGENT_CATALOG;
}

function RuntimeRefreshButton({
  onRefresh,
  refreshing,
}: {
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const { t } = useTranslation("teamRuntime");
  const { spinClass, handleClick } = useRefreshSpin(onRefresh, refreshing);
  return (
    <Button
      htmlType="button"
      variant="tertiary"
      appearance="ghost"
      size="small"
      disabled={refreshing}
      aria-label={t("refresh")}
      title={t("refresh")}
      onClick={handleClick}
      icon={
        <HugeiconsIcon
          icon={Refresh04Icon}
          data-icon="refresh-cw"
          size={14}
          className={spinClass}
        />
      }
      data-testid="team-runtime-refresh"
    >
      {t("refresh")}
    </Button>
  );
}

interface TeamRuntimeTodayConnectedProps {
  orgId: string;
  members: readonly MemberRuntimeListEntry[];
  telemetry: OrgRuntimeTelemetry | null;
  nowMs: number;
  language: string;
  selectedMemberId: string | null;
  onSelectMember: (userId: string | null) => void;
  refreshRoster: () => void;
  rosterRefreshing: boolean;
}

/**
 * Resource-owning boundary for the Today tab. Unmounting Today releases the
 * remote-session consumer entirely; Members keeps only the roster read.
 */
function TeamRuntimeTodayConnected({
  orgId,
  members,
  telemetry,
  nowMs,
  language,
  selectedMemberId,
  onSelectMember,
  refreshRoster,
  rosterRefreshing,
}: TeamRuntimeTodayConnectedProps) {
  const remoteSessions = useCloudOrgRemoteSessions(orgId);
  const openCloudSessionReference = useOpenCloudSessionReference();
  const refreshSessions = remoteSessions.refresh;
  const refreshAll = useCallback(() => {
    refreshRoster();
    refreshSessions();
  }, [refreshRoster, refreshSessions]);
  const handleOpenSession = useCallback(
    (row: RemoteTeammateSessionMetadata) => {
      openCloudSessionReference(
        {
          version: 1,
          orgId: row.orgId,
          ownerUserId: row.ownerUserId,
          sourceSessionId: row.sourceSessionId,
        },
        { autoReplay: row.eventsEpoch !== undefined }
      );
    },
    [openCloudSessionReference]
  );

  return (
    <TeamRuntimeToday
      members={members}
      telemetry={telemetry}
      nowMs={nowMs}
      language={language}
      selectedMemberId={selectedMemberId}
      onSelectMember={onSelectMember}
      sessionRows={remoteSessions.rows}
      sessionState={remoteSessions.state}
      onOpenSession={handleOpenSession}
      headerAction={
        <RuntimeRefreshButton
          onRefresh={refreshAll}
          refreshing={rosterRefreshing}
        />
      }
    />
  );
}

export type TeamRuntimeView = "today" | "members";

interface TeamRuntimePanelProps {
  /** Controlled by Runtime's organization scope picker. */
  orgId?: string;
  view?: TeamRuntimeView;
}

/** Chat pane → Runtime → organization: the selected org's runtime surface. */
export default function TeamRuntimePanel({
  orgId,
  view = "today",
}: TeamRuntimePanelProps) {
  const { t, i18n } = useTranslation("teamRuntime");
  const language = i18n.resolvedLanguage || i18n.language || "en";
  const roster = useTeamRuntimeRoster(orgId);
  const agentCatalog = useAgentCatalog(
    roster.phase === "ready" && view === "members" && roster.members.length > 0
  );
  const signIn = useOrg2CloudSignIn();

  const [openMemberId, setOpenMemberId] = useState<string | null>(null);
  const [selectedMemberId, setSelectedMemberId] = useState<string | null>(null);

  // One minute-aligned, visibility-aware clock keeps every card on the same
  // snapshot without making unrelated renders read wall-clock time.
  const nowMs = useTeamRuntimeClock();

  // Leaving the org scope or losing the member closes the drilldown.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- these ids are owned by the committed org/user scope and must not survive a scope transition
    setOpenMemberId(null);
    setSelectedMemberId(null);
  }, [roster.selectedOrgId, roster.currentUserId]);

  // A member drilldown belongs to the Members tab; don't retain a hidden
  // detail surface if the user returns to Today.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the controlled tab transition owns teardown of its hidden member drilldown
    if (view !== "members") setOpenMemberId(null);
  }, [view]);

  const visibleSelectedMemberId =
    selectedMemberId !== null &&
    roster.members.some((member) => member.userId === selectedMemberId)
      ? selectedMemberId
      : null;

  const openMember =
    openMemberId !== null
      ? (roster.members.find((member) => member.userId === openMemberId) ??
        null)
      : null;

  const membersByActivity = useMemo(() => {
    const active: MemberRuntimeListEntry[] = [];
    const inactive: MemberRuntimeListEntry[] = [];
    for (const member of roster.members) {
      (hasMemberActivityToday(member.recentDays, nowMs)
        ? active
        : inactive
      ).push(member);
    }
    return { active, inactive };
  }, [nowMs, roster.members]);

  // Stable across renders (setState setters never change identity) so the
  // `TeamMemberCard` React.memo comparison isn't busted by a fresh closure
  // every render — each card calls back with its own userId instead of
  // capturing it in a per-card arrow function at the call site.
  const handleOpenMember = useCallback((userId: string) => {
    setOpenMemberId(userId);
  }, []);

  let content: ReactNode;
  switch (roster.phase) {
    case "signedOut":
      content = (
        <Placeholder
          variant="empty"
          placement="detail-panel"
          title={t("signedOut.title")}
          subtitle={t("signedOut.subtitle")}
          action={{
            label: t("signedOut.action"),
            onClick: signIn,
            variant: "primary",
            dataTestId: "team-runtime-sign-in",
          }}
        />
      );
      break;
    case "noOrgs":
      content = (
        <Placeholder
          variant="empty"
          placement="detail-panel"
          title={t("noOrgs.title")}
          subtitle={t("noOrgs.subtitle")}
        />
      );
      break;
    case "unsupported":
      content = (
        <Placeholder
          variant="empty"
          placement="detail-panel"
          title={t("unsupported.title")}
          subtitle={t("unsupported.subtitle")}
        />
      );
      break;
    case "disabled":
      content = (
        <Placeholder
          variant="empty"
          placement="detail-panel"
          title={t("disabled.title")}
          subtitle={
            roster.isSelectedOrgAdmin
              ? t("disabled.adminSubtitle")
              : t("disabled.subtitle")
          }
        />
      );
      break;
    case "error":
      content = (
        <Placeholder
          variant="error"
          placement="detail-panel"
          title={t("loadError")}
          subtitle={roster.error ?? undefined}
          onRetry={roster.refresh}
        />
      );
      break;
    case "loading":
      content = <Placeholder variant="loading" placement="detail-panel" />;
      break;
    case "ready":
      if (view === "members" && openMember) {
        content = (
          <TeamMemberDetail
            entry={openMember}
            orgId={roster.selectedOrgId ?? ""}
            getFreshAccessToken={roster.getFreshAccessToken}
            agentCatalog={agentCatalog}
            language={language}
            onBack={() => setOpenMemberId(null)}
            headerAction={
              <RuntimeRefreshButton
                onRefresh={roster.refresh}
                refreshing={roster.refreshing}
              />
            }
          />
        );
      } else if (view === "today") {
        content = (
          <TeamRuntimeTodayConnected
            orgId={roster.selectedOrgId ?? ""}
            members={roster.members}
            telemetry={roster.telemetry}
            nowMs={nowMs}
            language={language}
            selectedMemberId={visibleSelectedMemberId}
            onSelectMember={setSelectedMemberId}
            refreshRoster={roster.refresh}
            rosterRefreshing={roster.refreshing}
          />
        );
      } else {
        content = (
          <div className="flex flex-col gap-5">
            <div
              className="flex min-h-9 flex-wrap items-center justify-between gap-3"
              data-testid="team-runtime-members-title-row"
            >
              <h3 className={SECTION_SUBHEADING_CLASSES}>
                {t("overview.members")}
              </h3>
              <div
                className="flex shrink-0 items-center"
                data-testid="team-runtime-controls"
              >
                <RuntimeRefreshButton
                  onRefresh={roster.refresh}
                  refreshing={roster.refreshing}
                />
              </div>
            </div>
            {roster.members.length > 0 ? (
              <div
                className="flex flex-col gap-5"
                data-testid="team-runtime-grid"
              >
                {(
                  [
                    ["active", membersByActivity.active],
                    ["inactive", membersByActivity.inactive],
                  ] as const
                ).map(([activity, members]) =>
                  members.length > 0 ? (
                    <section
                      key={activity}
                      className="flex flex-col gap-3"
                      data-testid={`team-runtime-${activity}-today`}
                    >
                      <h4 className={SECTION_SUBHEADING_CLASSES}>
                        {t(`overview.${activity}Today`)}
                      </h4>
                      <div className="grid grid-cols-1 gap-3 @[640px]:grid-cols-2">
                        {members.map((member) => (
                          <TeamMemberCard
                            key={member.userId}
                            entry={member}
                            telemetry={roster.telemetry}
                            nowMs={nowMs}
                            agentCatalog={agentCatalog}
                            isSelf={member.userId === roster.currentUserId}
                            onOpen={handleOpenMember}
                          />
                        ))}
                      </div>
                    </section>
                  ) : null
                )}
              </div>
            ) : (
              <div
                className="rounded-lg bg-bg-2 px-4 py-8 text-center"
                data-testid="team-runtime-no-members"
              >
                <div className="text-sm font-medium text-text-2">
                  {t("empty.title")}
                </div>
                <div className="mt-1 text-xs text-text-3">
                  {t("empty.subtitle")}
                </div>
              </div>
            )}
          </div>
        );
      }
      break;
  }

  return (
    <div className={SECTION_GAP_CLASSES} data-testid="team-runtime-panel">
      {roster.phase !== "signedOut" &&
      !(
        roster.phase === "ready" &&
        (view === "today" || view === "members")
      ) ? (
        <div
          className="flex min-h-9 items-center justify-end"
          data-testid="team-runtime-controls"
        >
          <RuntimeRefreshButton
            onRefresh={roster.refresh}
            refreshing={roster.refreshing}
          />
        </div>
      ) : null}

      {content}
    </div>
  );
}
