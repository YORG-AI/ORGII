/**
 * Chat pane → Runtime → Team: teammates' shared runtime — machine load,
 * usage/cost headlines, builder type, installed agents — read from ORG2 Cloud
 * (`cloud_list_member_runtime`) for the selected cloud org.
 *
 * The panel is read-only toward the org except for the footer self-service:
 * the signed-in member can stop sharing (local `privacy.shareRuntimeWithOrg`
 * setting) and delete their own reported rows (`cloud_clear_member_runtime`).
 */
import { RefreshCw } from "lucide-react";
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
import Select from "@src/components/Select";
import type { SettingsObject } from "@src/config/settingsSchema";
import { clearMemberRuntime } from "@src/features/Org2Cloud/memberRuntime/memberRuntimeClient";
import { resetMemberRuntimePushState } from "@src/features/Org2Cloud/memberRuntime/memberRuntimePushState";
import { SHARE_RUNTIME_SETTING_KEY } from "@src/features/Org2Cloud/memberRuntime/types";
import { useOrg2CloudSignIn } from "@src/features/Org2Cloud/useOrg2CloudSignIn";
import { useUpdateSettingsBatch } from "@src/hooks/settings/useSettings";
import { useRefreshSpin } from "@src/hooks/ui";
import {
  SECTION_GAP_CLASSES,
  SECTION_SUBHEADING_CLASSES,
} from "@src/modules/shared/layouts/SectionLayout";
import { Placeholder } from "@src/modules/shared/layouts/blocks";

import TeamMemberCard, {
  type AgentCatalog,
  type AgentCatalogEntry,
} from "./TeamMemberCard";
import TeamMemberDetail from "./TeamMemberDetail";
import { useTeamRuntimeRoster } from "./useTeamRuntimeRoster";

const EMPTY_AGENT_CATALOG: AgentCatalog = new Map<string, AgentCatalogEntry>();

/**
 * Installed-agent ids are stable provider ids; display names and icons come
 * from the local detection catalog (entries exist for every provider
 * regardless of local install status). One probe per panel mount.
 */
function useAgentCatalog(): AgentCatalog {
  const [catalog, setCatalog] = useState<AgentCatalog>(EMPTY_AGENT_CATALOG);
  useEffect(() => {
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
  }, []);
  return catalog;
}

/**
 * `privacy.shareRuntimeWithOrg` joins the settings registry with the plumbing
 * change; the cast keeps this file compiling against the pre-landing registry
 * while writing exactly the frozen key.
 */
function useSetShareRuntimeSetting(): (enabled: boolean) => void {
  const updateBatch = useUpdateSettingsBatch();
  return useCallback(
    (enabled: boolean) => {
      updateBatch({
        [SHARE_RUNTIME_SETTING_KEY]: enabled,
      } as Partial<SettingsObject>);
    },
    [updateBatch]
  );
}

/** Chat pane → Runtime → Team: the member-runtime roster. */
export default function TeamRuntimePanel() {
  const { t, i18n } = useTranslation("teamRuntime");
  const language = i18n.resolvedLanguage || i18n.language || "en";
  const roster = useTeamRuntimeRoster();
  const agentCatalog = useAgentCatalog();
  const signIn = useOrg2CloudSignIn();
  const setShareRuntime = useSetShareRuntimeSetting();

  const [openMemberId, setOpenMemberId] = useState<string | null>(null);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);

  // One clock per render pass so staleness and the today/7d fold agree across
  // every card. Quantized to the whole minute (org intervals are >=15min, so
  // ~1min staleness granularity is invisible) so an unrelated re-render (a
  // click, a settings change) recomputes the SAME nowMs value instead of a
  // strictly-increasing one — otherwise every card's `nowMs` prop would
  // differ by construction and the `TeamMemberCard` React.memo comparison
  // could never hold.
  const nowMs = Math.floor(Date.now() / 60_000) * 60_000;

  // Leaving the org scope or losing the member closes the drilldown.
  useEffect(() => {
    setOpenMemberId(null);
    setConfirmingStop(false);
    setStopError(null);
  }, [roster.selectedOrgId, roster.currentUserId]);

  const { spinClass, handleClick: handleRefreshClick } = useRefreshSpin(
    roster.refresh,
    roster.refreshing
  );

  const orgOptions = useMemo(
    () =>
      roster.orgs.map((org) => ({
        value: org.orgId,
        label: org.name,
        dataTestId: `team-runtime-org-${org.orgId}`,
      })),
    [roster.orgs]
  );

  const openMember =
    openMemberId !== null
      ? (roster.members.find((member) => member.userId === openMemberId) ??
        null)
      : null;

  // Stable across renders (setState setters never change identity) so the
  // `TeamMemberCard` React.memo comparison isn't busted by a fresh closure
  // every render — each card calls back with its own userId instead of
  // capturing it in a per-card arrow function at the call site.
  const handleOpenMember = useCallback((userId: string) => {
    setOpenMemberId(userId);
  }, []);

  const handleStopSharing = useCallback(async () => {
    if (stopping || !roster.selectedOrgId) return;
    setStopping(true);
    setStopError(null);
    // Flip the local opt-out first: it cannot fail, and the scheduler must
    // stop pushing even if the remote delete needs a retry.
    setShareRuntime(false);
    try {
      const accessToken = await roster.getFreshAccessToken();
      await clearMemberRuntime(accessToken, roster.selectedOrgId);
      // The server just deleted every row this member reported. Without
      // resetting the local fingerprint cursor, re-enabling sharing would
      // see "unchanged" usage-days/profile/agents against content the
      // server no longer has and skip re-sending them.
      if (roster.identityKey) {
        resetMemberRuntimePushState(roster.identityKey, roster.selectedOrgId);
      }
      setConfirmingStop(false);
      roster.refresh();
    } catch (err) {
      setStopError(err instanceof Error ? err.message : String(err));
    } finally {
      setStopping(false);
    }
  }, [roster, setShareRuntime, stopping]);

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
      if (openMember) {
        content = (
          <TeamMemberDetail
            entry={openMember}
            orgId={roster.selectedOrgId ?? ""}
            getFreshAccessToken={roster.getFreshAccessToken}
            agentCatalog={agentCatalog}
            language={language}
            onBack={() => setOpenMemberId(null)}
          />
        );
      } else if (roster.members.length === 0) {
        content = (
          <Placeholder
            variant="empty"
            placement="detail-panel"
            title={t("empty.title")}
            subtitle={t("empty.subtitle")}
          />
        );
      } else {
        content = (
          <>
            <div
              className="grid grid-cols-1 gap-3 @[640px]:grid-cols-2"
              data-testid="team-runtime-grid"
            >
              {roster.members.map((member) => (
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

            <div
              className="flex flex-wrap items-center justify-between gap-2 border-t border-border-1 pt-3"
              data-testid="team-runtime-self-service"
            >
              <span className="text-[11px] text-text-3">
                {t("selfService.hint")}
              </span>
              {confirmingStop ? (
                <span className="flex items-center gap-2">
                  <span className="text-xs text-text-2">
                    {t("selfService.confirm")}
                  </span>
                  <Button
                    variant="danger"
                    size="small"
                    loading={stopping}
                    disabled={stopping}
                    onClick={() => void handleStopSharing()}
                    data-testid="team-runtime-stop-confirm"
                  >
                    {t("selfService.confirmYes")}
                  </Button>
                  <Button
                    variant="tertiary"
                    size="small"
                    disabled={stopping}
                    onClick={() => {
                      setConfirmingStop(false);
                      setStopError(null);
                    }}
                    data-testid="team-runtime-stop-cancel"
                  >
                    {t("selfService.confirmNo")}
                  </Button>
                </span>
              ) : (
                <Button
                  variant="tertiary"
                  size="small"
                  onClick={() => setConfirmingStop(true)}
                  data-testid="team-runtime-stop-sharing"
                >
                  {t("selfService.action")}
                </Button>
              )}
              {stopError ? (
                <span className="w-full text-right text-[12px] text-danger-6">
                  {stopError}
                </span>
              ) : null}
            </div>
          </>
        );
      }
      break;
  }

  return (
    <div className={SECTION_GAP_CLASSES} data-testid="team-runtime-panel">
      <div
        className="flex min-h-9 flex-wrap items-center justify-between gap-3"
        data-testid="team-runtime-controls"
      >
        <h3 className={SECTION_SUBHEADING_CLASSES}>{t("title")}</h3>
        <div className="flex min-w-0 items-center gap-2">
          {roster.orgs.length > 1 ? (
            <Select
              value={roster.selectedOrgId ?? undefined}
              options={orgOptions}
              onChange={(value) => roster.selectOrg(String(value))}
              variant="ghost"
              size="small"
              dataTestId="team-runtime-org-select"
            />
          ) : null}
          {roster.phase !== "signedOut" ? (
            <Button
              htmlType="button"
              variant="tertiary"
              appearance="ghost"
              size="small"
              disabled={roster.refreshing}
              aria-label={t("refresh")}
              title={t("refresh")}
              onClick={handleRefreshClick}
              icon={<RefreshCw size={14} className={spinClass} />}
              data-testid="team-runtime-refresh"
            >
              {t("refresh")}
            </Button>
          ) : null}
        </div>
      </div>

      {content}
    </div>
  );
}
