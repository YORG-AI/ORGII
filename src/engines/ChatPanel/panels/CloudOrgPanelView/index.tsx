/**
 * Panel for a managed ORG2 Cloud org.
 *
 * Managed-backend counterpart to `CollabOrgPanelView` (self-hosted). Shows
 * plan/entitlement (`get_entitlement_state`) and members
 * (`list_org_members`) fetched straight from the ORG2 Cloud client — it
 * never touches `collabOrgsAtom` or the CollabSyncEngine.
 *
 * Phase 6 additions: repo scope editing (admin-only, `cloud_set_org_repo_
 * scopes` + the local `org2CloudRepoScopesAtom` mirror that drives the
 * desktop push engine).
 *
 * Org-management closed loop (migration 0010, self-hosted parity): invites
 * (create/list/revoke with a one-time copyable link), member role changes /
 * removal, leave, rename, ownership transfer and org deletion — state and
 * handlers in `useCloudOrgManagement`, sections in `ManagementSections`.
 *
 * Teammates' shared sessions no longer render here — they live in the LEFT
 * SIDEBAR as fork-threaded groups when the cloud org is the active scope
 * (WorkstationSidebarConnector/cloudSessionsSection + the extracted
 * `useCloudSessionActions` replay/fork hook). No chat/work items yet.
 */
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Cloud, Laptop } from "lucide-react";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Select from "@src/components/Select";
import TabPill, { type TabPillItem } from "@src/components/TabPill";
import {
  floorAccessMode,
  getCloudOrgAccessSettings,
  getOrgSharingFloor,
  isAccessModeAtLeast,
  org2CloudAccessSettingsAtom,
  org2CloudSharingFloorAtom,
  withCloudOrgDefaultMode,
} from "@src/features/Org2Cloud/org2CloudAccessSettings";
import {
  commitRefreshedAuth,
  org2CloudAuthAtom,
} from "@src/features/Org2Cloud/org2CloudAuthAtom";
import {
  type CloudEntitlementState,
  type CloudOrgMember,
  ensureFreshSession,
  getEntitlementState,
  listOrgMembers,
} from "@src/features/Org2Cloud/org2CloudClient";
import {
  org2CloudOrgsAtom,
  org2CloudRosterVersionAtom,
} from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import {
  deriveScopeQuotaView,
  parseScopeCooldownFreesAt,
} from "@src/features/Org2Cloud/org2CloudScopeQuota";
import { org2CloudRepoScopesAtom } from "@src/features/Org2Cloud/org2CloudSyncAtoms";
import {
  type CloudOrgScopeState,
  getOrgRepoScopes,
  isOrg2SyncErrorCode,
  setOrgRepoScopes,
  setOrgSharingFloor,
} from "@src/features/Org2Cloud/org2CloudSyncClient";
import { org2CloudSyncEngine } from "@src/features/Org2Cloud/org2CloudSyncEngine";
import { useOpenCloudBilling } from "@src/features/Org2Cloud/useOpenCloudBilling";
import RepoScopePicker from "@src/features/TeamCollaboration/components/RepoScopePicker";
import { createLogger } from "@src/hooks/logger";
import { useTauriListen } from "@src/hooks/platform/useTauriListen";
import {
  SECTION_CONTROL_STYLE,
  SECTION_DESCRIPTION_CLASSES,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import {
  DETAIL_PANEL_TOKENS,
  InternalHeader,
  ScrollFadeContainer,
} from "@src/modules/shared/layouts/blocks";
import { Placeholder } from "@src/modules/shared/layouts/blocks/Placeholder";
import {
  openCloudOrgManagementInChatPanelTabAtom,
  openWorkspaceOverviewInChatPanelTabAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import { COLLAB_SESSION_ACCESS_MODE } from "@src/store/collaboration/types";
import type { CollabSessionAccessMode } from "@src/store/collaboration/types";
import { reposAtom } from "@src/store/repo";
import {
  type ChatPanelSelectedCloudOrg,
  WORKSPACE_OVERVIEW_TAB,
} from "@src/store/ui/chatPanelAtom";
import { savedWorkspacesAtom } from "@src/store/ui/workspaceFoldersAtom";
import { isTauriReady } from "@src/util/platform/tauri/init";

import {
  CloudInvitesCard,
  CloudMembersSection,
  CloudOrgSettingsSection,
} from "./ManagementSections";
import {
  buildCloudOrgSelectorValue,
  buildLocalRepoSelectorValue,
  buildLocalWorkspaceSelectorValue,
  parseManagementTarget,
} from "./managementTargetSelector";
import { useCloudOrgManagement } from "./useCloudOrgManagement";

const log = createLogger("CloudOrgPanelView");

interface CloudOrgPanelViewProps {
  selectedCloudOrg: ChatPanelSelectedCloudOrg;
}

type FetchState = "loading" | "ready" | "error";
type CloudOrgManagementTab = "general" | "repo-scope" | "members";

const CLOUD_ORG_MANAGEMENT_TAB = {
  GENERAL: "general",
  REPO_SCOPE: "repo-scope",
  MEMBERS: "members",
} as const satisfies Record<string, CloudOrgManagementTab>;

export const CloudOrgPanelView: React.FC<CloudOrgPanelViewProps> = ({
  selectedCloudOrg,
}) => {
  const { t } = useTranslation("navigation");
  const { t: tSettings } = useTranslation("settings");
  // Billing lives on the cloud web app; this is the desktop's durable
  // upgrade surface (the sync engine's quota toast points users here — the
  // engine itself is React-free and cannot render an action button).
  const openCloudBillingPage = useOpenCloudBilling();
  const [auth, setAuth] = useAtom(org2CloudAuthAtom);
  const cloudOrgs = useAtomValue(org2CloudOrgsAtom);
  const localRepos = useAtomValue(reposAtom);
  const localWorkspaces = useAtomValue(savedWorkspacesAtom);
  const openCloudOrgManagementTab = useSetAtom(
    openCloudOrgManagementInChatPanelTabAtom
  );
  const openWorkspaceOverviewTab = useSetAtom(
    openWorkspaceOverviewInChatPanelTabAtom
  );
  const [activeTab, setActiveTab] = useState<CloudOrgManagementTab>(
    CLOUD_ORG_MANAGEMENT_TAB.GENERAL
  );
  // Live roster invalidation: the Realtime org-wide membership subscription
  // bumps this per-org counter (useOrg2CloudRealtime); keying the fetch on
  // it makes a teammate's join/leave/role-change appear without re-opening
  // the panel.
  const rosterVersionByOrg = useAtomValue(org2CloudRosterVersionAtom);
  const [entitlement, setEntitlement] = useState<CloudEntitlementState | null>(
    null
  );
  const [members, setMembers] = useState<CloudOrgMember[]>([]);
  const [fetchState, setFetchState] = useState<FetchState>("loading");
  const [repoScopesByOrg, setRepoScopesByOrg] = useAtom(
    org2CloudRepoScopesAtom
  );
  // Access ladder (§13.4): per-org DEFAULT sync level for repo-scope-matched
  // sessions. Local persisted setting — per-session overrides are edited
  // from each session's context menu (CloudSyncLevelDialog).
  const [accessByOrg, setAccessByOrg] = useAtom(org2CloudAccessSettingsAtom);
  // Admin sharing floor (org policy). The atom mirrors the server truth
  // (hydrated from get_entitlement_state below); admins mutate it via the RPC.
  const [floorByOrg, setFloorByOrg] = useAtom(org2CloudSharingFloorAtom);
  const [savingFloor, setSavingFloor] = useState(false);
  const [floorError, setFloorError] = useState<string | null>(null);
  const [scopeState, setScopeState] = useState<CloudOrgScopeState | null>(null);
  const [savingScopes, setSavingScopes] = useState(false);
  const [scopesSaved, setScopesSaved] = useState(false);
  const [scopesError, setScopesError] = useState<string | null>(null);
  // Bumped when a checkout completes in the system browser
  // (org2-cloud-billing-complete, re-emitted by useDeepLinkHandler from the
  // orgii://billing/complete deep link) so the panel re-pulls
  // entitlement/members/scopes and the plan badge flips without reopening
  // the panel.
  const [refreshNonce, setRefreshNonce] = useState(0);
  useTauriListen(
    "org2-cloud-billing-complete",
    () => {
      log.info("billing checkout completed — refreshing org panel");
      setRefreshNonce((n) => n + 1);
    },
    { enabled: isTauriReady() }
  );

  const org = cloudOrgs.find((o) => o.orgId === selectedCloudOrg.orgId);
  const orgId = selectedCloudOrg.orgId;
  const rosterVersion = rosterVersionByOrg[orgId] ?? 0;
  const signedIn = Boolean(auth);
  const isAdmin = org?.role === "admin" || org?.role === "owner";
  const isOwner = org?.role === "owner";
  const currentUserId = auth?.userId ?? null;
  const savedScopes = useMemo(
    () => repoScopesByOrg[orgId] ?? [],
    [repoScopesByOrg, orgId]
  );
  const [draftScopes, setDraftScopes] = useState<string[]>(savedScopes);
  // Re-seed the draft when the panel switches orgs.
  useEffect(() => {
    setDraftScopes(repoScopesByOrg[orgId] ?? []);
    setScopeState(null);
    setScopesSaved(false);
    setScopesError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId]);
  const scopesDirty = useMemo(
    () =>
      savedScopes.length !== draftScopes.length ||
      savedScopes.some((scope, index) => scope !== draftScopes[index]),
    [savedScopes, draftScopes]
  );
  // Dirty flag via ref so the async org-load effect can check it at resolve
  // time (same idiom as authRef below) without retriggering on edits.
  const scopesDirtyRef = useRef(scopesDirty);
  useEffect(() => {
    scopesDirtyRef.current = scopesDirty;
  }, [scopesDirty]);
  // Quota view derives from server occupancy (`used` counts cooling slots
  // too, so it may exceed the visible scope list).
  const scopeQuota = useMemo(
    () =>
      scopeState
        ? deriveScopeQuotaView({ scopeState, draft: draftScopes })
        : null,
    [scopeState, draftScopes]
  );
  // Latest auth via ref so the token-refresh write inside the effect does
  // not retrigger the fetch (effect keys on orgId + signed-in flag only).
  const authRef = useRef(auth);
  useEffect(() => {
    authRef.current = auth;
  }, [auth]);

  // Org-management state + handlers (invites / members / settings).
  const management = useCloudOrgManagement({
    orgId,
    orgName: org?.name ?? "",
    isAdmin,
    isOwner,
    members,
    setMembers,
  });

  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    void (async () => {
      setFetchState("loading");
      const current = authRef.current;
      if (!current) {
        if (!cancelled) setFetchState("error");
        return;
      }
      const fresh = await ensureFreshSession(current);
      if (!fresh) {
        log.warn("cloud org panel fetch skipped: token refresh failed");
        if (!cancelled) setFetchState("error");
        return;
      }
      commitRefreshedAuth(setAuth, current, fresh);
      const [entitlementResult, membersResult, scopeStateResult] =
        await Promise.all([
          getEntitlementState(fresh.accessToken, orgId),
          listOrgMembers(fresh.accessToken, orgId),
          // Scope governance is best-effort: the panel still renders (with
          // the local mirror) when the RPC fails.
          getOrgRepoScopes(fresh.accessToken, orgId).catch((error: unknown) => {
            log.warn("cloud_get_org_repo_scopes failed:", error);
            return null;
          }),
        ]);
      if (cancelled) return;
      setEntitlement(entitlementResult);
      // Hydrate the local sharing-floor mirror from server truth (only when
      // the fetch succeeded — a null result must not clobber the last-known
      // floor the push engine relies on).
      if (entitlementResult) {
        const nextFloor =
          entitlementResult.orgSharingFloor ?? COLLAB_SESSION_ACCESS_MODE.OFF;
        setFloorByOrg((prev) =>
          prev[orgId] === nextFloor ? prev : { ...prev, [orgId]: nextFloor }
        );
      }
      setMembers(membersResult);
      if (scopeStateResult) {
        // Server truth replaces the local mirror (cross-device hydration)
        // and re-seeds the draft — but ONLY when the admin has no in-flight
        // edits (a dirty draft must never be clobbered by a slow fetch).
        setScopeState(scopeStateResult);
        setRepoScopesByOrg((prev) => ({
          ...prev,
          [orgId]: scopeStateResult.repoScopes,
        }));
        if (!scopesDirtyRef.current) {
          setDraftScopes(scopeStateResult.repoScopes);
        }
      }
      // Entitlement is a best-effort plan badge — a transient
      // `get_entitlement_state` failure (it returns null on ANY error) must NOT
      // blank the whole panel (members / invites / repo scopes / leave /
      // transfer / delete). Treat the fetch as ready as long as SOMETHING
      // loaded; a viewable signed-in org always has >=1 member, so an empty
      // members list alongside a null entitlement means the whole fetch failed
      // (keep the clean full-panel error for that case).
      setFetchState(
        entitlementResult || membersResult.length > 0 ? "ready" : "error"
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [
    orgId,
    signedIn,
    refreshNonce,
    rosterVersion,
    setAuth,
    setRepoScopesByOrg,
    setFloorByOrg,
  ]);

  // Re-read quota/cooling after a save attempt — a save changes occupancy
  // (success) or reveals a cooling slot (ORG2_SCOPE_COOLDOWN).
  const refreshScopeState = async (accessToken: string): Promise<void> => {
    try {
      const state = await getOrgRepoScopes(accessToken, orgId);
      setScopeState(state);
      setRepoScopesByOrg((prev) => ({ ...prev, [orgId]: state.repoScopes }));
    } catch (error) {
      log.warn("cloud_get_org_repo_scopes refresh failed:", error);
    }
  };

  const handleSaveScopes = async (): Promise<void> => {
    const current = authRef.current;
    if (!current) return;
    setSavingScopes(true);
    setScopesError(null);
    setScopesSaved(false);
    // Captured for the catch: authRef may still hold the pre-refresh token
    // when the save rejects (ORG2_SCOPE_COOLDOWN refetch below).
    let freshToken: string | null = null;
    try {
      const fresh = await ensureFreshSession(current);
      if (!fresh) throw new Error(t("cloud.orgPanel.loadError"));
      commitRefreshedAuth(setAuth, current, fresh);
      freshToken = fresh.accessToken;
      await setOrgRepoScopes(fresh.accessToken, orgId, draftScopes);
      // Local mirror drives the desktop push engine (server truth re-read
      // right below).
      setRepoScopesByOrg((prev) => ({ ...prev, [orgId]: draftScopes }));
      setScopesSaved(true);
      await refreshScopeState(fresh.accessToken);
    } catch (error) {
      if (isOrg2SyncErrorCode(error, "ORG2_SCOPE_COOLDOWN")) {
        const freesAt = parseScopeCooldownFreesAt(
          error instanceof Error ? error.message : ""
        );
        setScopesError(
          freesAt
            ? t("cloud.orgPanel.scopeCooldownError", {
                date: freesAt.toLocaleDateString(),
              })
            : t("cloud.orgPanel.scopeCooldownErrorNoDate")
        );
        // The rejected save still tells us a slot is cooling — pick up its
        // frees-at for the greyed rows, using the token freshened for the
        // save (authRef may lag behind the refresh).
        if (freshToken) await refreshScopeState(freshToken);
        return;
      }
      setScopesError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingScopes(false);
    }
  };

  // Admin sharing FLOOR for this org (0002 policy). Members can't set a
  // per-device default (or per-session override) below it.
  const orgFloor = getOrgSharingFloor(floorByOrg, orgId);

  // Default sync level (access ladder §13.4). Options reuse the shared
  // ladder labels; the value writes straight to the persisted settings atom
  // and a drained sync pass is kicked so upgrades, downgrades, and retractions
  // are applied promptly. Modes below the org floor are dropped — the
  // engine floors them anyway, so offering them would only mislead.
  const defaultAccessMode = getCloudOrgAccessSettings(
    accessByOrg,
    orgId
  ).defaultMode;
  const accessModeOptions = useMemo(
    () =>
      [
        {
          value: COLLAB_SESSION_ACCESS_MODE.OFF,
          label: t("cloud.syncLevel.modeOff"),
          dataTestId: "cloud-org-default-access-off",
        },
        {
          value: COLLAB_SESSION_ACCESS_MODE.METADATA_ONLY,
          label: t("cloud.syncLevel.modeMetadata"),
          dataTestId: "cloud-org-default-access-metadata",
        },
        {
          value: COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY,
          label: t("cloud.syncLevel.modeFullReplay"),
          dataTestId: "cloud-org-default-access-full",
        },
      ].filter((option) => isAccessModeAtLeast(option.value, orgFloor)),
    [t, orgFloor]
  );
  const handleDefaultAccessChange = useCallback(
    (value: string | number | (string | number)[]) => {
      setAccessByOrg((current) =>
        withCloudOrgDefaultMode(
          current,
          orgId,
          value as CollabSessionAccessMode
        )
      );
      void org2CloudSyncEngine.runSyncPassAndWaitForDrain();
    },
    [orgId, setAccessByOrg]
  );

  // Admin-only: options for the org sharing FLOOR select. 'off' means "no
  // minimum" (members choose freely, today's behaviour).
  const floorOptions = useMemo(
    () => [
      {
        value: COLLAB_SESSION_ACCESS_MODE.OFF,
        label: t("cloud.sharingFloor.optionNone"),
        dataTestId: "cloud-org-sharing-floor-off",
      },
      {
        value: COLLAB_SESSION_ACCESS_MODE.METADATA_ONLY,
        label: t("cloud.syncLevel.modeMetadata"),
        dataTestId: "cloud-org-sharing-floor-metadata",
      },
      {
        value: COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY,
        label: t("cloud.syncLevel.modeFullReplay"),
        dataTestId: "cloud-org-sharing-floor-full",
      },
    ],
    [t]
  );
  // Admin sets the org floor: optimistic mirror write, RPC, then revert +
  // surface the error on failure (e.g. ORG2_ADMIN_REQUIRED if they just lost
  // admin). A sync pass applies the new floor to this device's pushes at once.
  const handleFloorChange = async (
    value: string | number | (string | number)[]
  ): Promise<void> => {
    const next = value as CollabSessionAccessMode;
    const previous = orgFloor;
    if (next === previous) return;
    const current = authRef.current;
    if (!current) return;
    setFloorError(null);
    setSavingFloor(true);
    setFloorByOrg((prev) => ({ ...prev, [orgId]: next }));
    try {
      const fresh = await ensureFreshSession(current);
      if (!fresh) throw new Error(t("cloud.orgPanel.loadError"));
      commitRefreshedAuth(setAuth, current, fresh);
      await setOrgSharingFloor(fresh.accessToken, orgId, next);
      await org2CloudSyncEngine.runSyncPassAndWaitForDrain();
    } catch (error) {
      setFloorByOrg((prev) => ({ ...prev, [orgId]: previous }));
      setFloorError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingFloor(false);
    }
  };

  // Cooling slots render greyed and non-removable in both the admin editor
  // and the read-only list — the slot is occupied server-side either way.
  const coolingRowsBlock =
    scopeQuota && scopeQuota.coolingRows.length > 0
      ? scopeQuota.coolingRows.map((row) => (
          <div key={row.scopeKey} data-testid="cloud-org-cooling-scope">
            <SectionRow
              label={<span title={row.scopeKey}>{row.scopeKey}</span>}
              truncateLabel
              light
            >
              <span className="text-[12px] text-text-3">
                {t("cloud.orgPanel.scopeCoolingRow", { days: row.daysLeft })}
              </span>
            </SectionRow>
          </div>
        ))
      : null;

  const orgName = org?.name ?? "";
  const managementTargetOptions = useMemo(
    () => [
      ...cloudOrgs.map((cloudOrg) => ({
        value: buildCloudOrgSelectorValue(cloudOrg.orgId),
        label: cloudOrg.name,
        icon: <Cloud size={13} strokeWidth={2} />,
        dataTestId: `cloud-org-switch-option-${cloudOrg.orgId}`,
      })),
      ...localWorkspaces.map((workspace) => ({
        value: buildLocalWorkspaceSelectorValue(workspace.workspaceId),
        label: workspace.name,
        icon: <Laptop size={13} strokeWidth={2} />,
        dataTestId: `local-workspace-switch-option-${workspace.workspaceId}`,
      })),
      ...localRepos.map((repo) => ({
        value: buildLocalRepoSelectorValue(repo.id),
        label: repo.name || repo.path?.split("/").pop() || t("workspace"),
        icon: <Laptop size={13} strokeWidth={2} />,
        dataTestId: `local-repo-switch-option-${repo.id}`,
      })),
    ],
    [cloudOrgs, localRepos, localWorkspaces, t]
  );
  const managementTabs = useMemo<TabPillItem[]>(
    () => [
      {
        key: CLOUD_ORG_MANAGEMENT_TAB.GENERAL,
        label: tSettings("sections.general"),
        dataTestId: "cloud-org-tab-general",
      },
      {
        key: CLOUD_ORG_MANAGEMENT_TAB.REPO_SCOPE,
        label: t("cloud.orgPanel.repoScopesTitle"),
        dataTestId: "cloud-org-tab-repo-scope",
      },
      {
        key: CLOUD_ORG_MANAGEMENT_TAB.MEMBERS,
        label: t("cloud.orgPanel.membersTitle"),
        dataTestId: "cloud-org-tab-members",
      },
    ],
    [t, tSettings]
  );
  const handleOrgChange = useCallback(
    (value: string | number | (string | number)[]) => {
      if (Array.isArray(value)) return;
      const selectorValue = String(value);
      const target = parseManagementTarget(selectorValue);
      if (!target) return;

      if (target.kind === "cloud-org") {
        if (target.id === orgId) return;
        openCloudOrgManagementTab({
          cloudOrg: { orgId: target.id },
          title: t("collaboration.manageOrg"),
        });
        return;
      }

      if (target.kind === "local-repo") {
        const repo = localRepos.find((candidate) => candidate.id === target.id);
        if (!repo) return;
        openWorkspaceOverviewTab({
          workspace: {
            kind: "repo",
            id: repo.id,
            name: repo.name || repo.path?.split("/").pop() || t("workspace"),
            path: repo.path,
          },
          tab: WORKSPACE_OVERVIEW_TAB.DETAILS,
        });
        return;
      }

      const workspace = localWorkspaces.find(
        (candidate) => candidate.workspaceId === target.id
      );
      if (!workspace) return;
      const primaryFolder =
        workspace.folders.find((folder) => folder.isPrimary) ??
        workspace.folders[0];
      openWorkspaceOverviewTab({
        workspace: {
          kind: "workspace",
          id: workspace.workspaceId,
          name: workspace.name,
          path: primaryFolder?.folderPath,
          folderCount: workspace.folders.length,
          repoIds: workspace.folders.flatMap((folder) =>
            folder.repoId ? [folder.repoId] : []
          ),
        },
        tab: WORKSPACE_OVERVIEW_TAB.OVERVIEW,
      });
    },
    [
      localRepos,
      localWorkspaces,
      openCloudOrgManagementTab,
      openWorkspaceOverviewTab,
      orgId,
      t,
    ]
  );
  // Signed out (e.g. sign-out while the panel is open) renders as an error
  // state without any effect-driven state write.
  const viewState: FetchState = signedIn ? fetchState : "error";

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      data-testid="cloud-org-panel"
    >
      <InternalHeader
        noPanelHeader
        contentPadding
        className={DETAIL_PANEL_TOKENS.headerWidth}
        dataTestId="cloud-org-management-header"
        tabs={
          <div className="flex w-full min-w-0 flex-col items-start gap-2">
            <Select
              value={buildCloudOrgSelectorValue(orgId)}
              options={managementTargetOptions}
              onChange={handleOrgChange}
              showSearch={managementTargetOptions.length > 8}
              variant="ghost"
              size="large"
              radius="pill"
              className="-ml-4 !w-fit shrink-0 [&_.select-value>span:last-child]:!overflow-visible [&_.select-value]:!overflow-visible"
              selectorClassName="whitespace-nowrap font-medium"
              dataTestId="cloud-org-switcher"
            />
            <div className="max-w-full overflow-x-auto scrollbar-hide">
              <TabPill
                tabs={managementTabs}
                activeTab={activeTab}
                onChange={(key) => setActiveTab(key as CloudOrgManagementTab)}
                variant="simple"
                fillWidth={false}
                size="large"
              />
            </div>
          </div>
        }
      />
      <ScrollFadeContainer
        className={`scroll-fade-at-top ${DETAIL_PANEL_TOKENS.scrollContentNoTop}`}
      >
        <div className={DETAIL_PANEL_TOKENS.contentWidthWithPaddingNoTop}>
          {viewState === "loading" ? (
            <Placeholder variant="loading" />
          ) : viewState === "error" ? (
            <p className="text-[12px] text-text-3">
              {t("cloud.orgPanel.loadError")}
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {activeTab === CLOUD_ORG_MANAGEMENT_TAB.GENERAL ? (
                <>
                  <div data-testid="cloud-org-plan-section">
                    <SectionContainer>
                      {entitlement ? (
                        <>
                          <SectionRow
                            label={t("cloud.orgPanel.planStatus", {
                              plan: entitlement.plan,
                              status: entitlement.status,
                            })}
                            description={
                              entitlement.plan !== "free"
                                ? t("cloud.orgPanel.manageBillingNote")
                                : undefined
                            }
                          >
                            {entitlement.plan === "free" ? (
                              <Button
                                htmlType="button"
                                size="default"
                                variant="primary"
                                onClick={openCloudBillingPage}
                                data-testid="cloud-org-plan-upgrade"
                              >
                                {t("cloud.orgPanel.upgrade")}
                              </Button>
                            ) : (
                              <Button
                                htmlType="button"
                                size="default"
                                variant="secondary"
                                onClick={openCloudBillingPage}
                                data-testid="cloud-org-plan-manage-billing"
                              >
                                {t("cloud.orgPanel.manageBilling")}
                              </Button>
                            )}
                          </SectionRow>
                          {typeof entitlement.replayRetentionDays ===
                          "number" ? (
                            <SectionRow
                              label={t("cloud.orgPanel.retention", {
                                days: entitlement.replayRetentionDays,
                              })}
                              description={t("cloud.orgPanel.retentionNote")}
                            />
                          ) : null}
                        </>
                      ) : (
                        <div data-testid="cloud-org-plan-error">
                          <SectionRow
                            label={t("cloud.orgPanel.loadError")}
                            light
                          />
                        </div>
                      )}
                    </SectionContainer>
                  </div>

                  {/* Org sharing FLOOR (0002 policy). Admins set the minimum level
                every member must share at; members see it read-only. Sits
                above the per-device default because it CONSTRAINS that
                default. */}
                  {isAdmin ? (
                    <SectionContainer>
                      <SectionRow
                        label={t("cloud.sharingFloor.label")}
                        description={t("cloud.sharingFloor.help")}
                        align="start"
                      >
                        <div
                          className="flex flex-col gap-2"
                          data-testid="cloud-org-sharing-floor"
                        >
                          <Select
                            value={orgFloor}
                            options={floorOptions}
                            onChange={(value) => void handleFloorChange(value)}
                            size="default"
                            style={SECTION_CONTROL_STYLE}
                            disabled={savingFloor}
                            dataTestId="cloud-org-sharing-floor-select"
                          />
                          {floorError ? (
                            <span className="text-[12px] text-danger-6">
                              {floorError}
                            </span>
                          ) : null}
                        </div>
                      </SectionRow>
                    </SectionContainer>
                  ) : orgFloor !== COLLAB_SESSION_ACCESS_MODE.OFF ? (
                    <SectionContainer>
                      <div data-testid="cloud-org-sharing-floor-member-note">
                        <SectionRow
                          label={t("cloud.sharingFloor.label")}
                          description={t("cloud.sharingFloor.memberNote", {
                            mode:
                              orgFloor ===
                              COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY
                                ? t("cloud.syncLevel.modeFullReplay")
                                : t("cloud.syncLevel.modeMetadata"),
                          })}
                        />
                      </div>
                    </SectionContainer>
                  ) : null}

                  {/* Default per-session sync level for THIS device's sessions in
                this org (access ladder §13.4). Sits with the sync plumbing:
                repo scopes pick candidates, this default gates uploads. */}
                  <SectionContainer>
                    <SectionRow
                      label={t("cloud.defaultAccess.label")}
                      description={t("cloud.defaultAccess.help")}
                      align="start"
                    >
                      <div
                        className="flex flex-col gap-2"
                        data-testid="cloud-org-default-access"
                      >
                        <Select
                          value={floorAccessMode(defaultAccessMode, orgFloor)}
                          options={accessModeOptions}
                          onChange={handleDefaultAccessChange}
                          size="default"
                          style={SECTION_CONTROL_STYLE}
                          dataTestId="cloud-org-default-access-select"
                        />
                      </div>
                    </SectionRow>
                  </SectionContainer>
                </>
              ) : null}

              {activeTab === CLOUD_ORG_MANAGEMENT_TAB.MEMBERS ? (
                <>
                  {isAdmin ? (
                    <CloudInvitesCard t={t} management={management} />
                  ) : null}

                  {members.length === 0 ? (
                    <SectionContainer title={t("cloud.orgPanel.membersTitle")}>
                      <SectionRow
                        label={t("cloud.orgPanel.membersEmpty")}
                        light
                      />
                    </SectionContainer>
                  ) : (
                    <CloudMembersSection
                      t={t}
                      members={members}
                      currentUserId={currentUserId}
                      management={management}
                    />
                  )}
                </>
              ) : null}

              {activeTab === CLOUD_ORG_MANAGEMENT_TAB.REPO_SCOPE ? (
                <SectionContainer
                  title={
                    scopeQuota
                      ? `${t("cloud.orgPanel.repoScopesTitle")} · ${scopeQuota.counterLabel}`
                      : t("cloud.orgPanel.repoScopesTitle")
                  }
                >
                  <div data-testid="cloud-org-repo-scope">
                    <SectionRow showHeader={false}>
                      <p className={`m-0 ${SECTION_DESCRIPTION_CLASSES}`}>
                        {t("cloud.orgPanel.repoScopesHelp")}
                      </p>
                    </SectionRow>
                    {isAdmin ? (
                      <>
                        {draftScopes.length === 0 && !coolingRowsBlock ? (
                          <SectionRow
                            label={t("cloud.orgPanel.repoScopesEmpty")}
                            light
                          />
                        ) : (
                          draftScopes.map((path) => (
                            <SectionRow
                              key={path}
                              label={<span title={path}>{path}</span>}
                              truncateLabel
                            >
                              <Button
                                htmlType="button"
                                size="default"
                                variant="secondary"
                                onClick={() =>
                                  setDraftScopes(
                                    draftScopes.filter(
                                      (scope) => scope !== path
                                    )
                                  )
                                }
                              >
                                {t("cloud.orgPanel.removeRepoScope")}
                              </Button>
                            </SectionRow>
                          ))
                        )}
                        {coolingRowsBlock}
                        <SectionRow showHeader={false}>
                          <RepoScopePicker
                            selectedKeys={draftScopes}
                            onChange={setDraftScopes}
                            disabled={
                              savingScopes || Boolean(scopeQuota?.atCap)
                            }
                          />
                        </SectionRow>
                        {scopeQuota?.atCap ? (
                          <SectionRow showHeader={false}>
                            <div
                              className="flex flex-wrap items-center gap-2 rounded-lg bg-warning-1 px-3 py-2 text-[12px] text-warning-6"
                              data-testid="cloud-org-scope-cap-upgrade"
                            >
                              <span>
                                {t("cloud.orgPanel.scopeCapReached", {
                                  used: scopeQuota.used,
                                  cap: scopeQuota.cap,
                                })}
                              </span>
                              <Button
                                htmlType="button"
                                size="default"
                                variant="warning"
                                appearance="ghost"
                                onClick={openCloudBillingPage}
                                data-testid="cloud-org-scope-cap-upgrade-link"
                              >
                                {t("cloud.orgPanel.upgrade")}
                              </Button>
                            </div>
                          </SectionRow>
                        ) : null}
                        <SectionRow showHeader={false}>
                          <div className="flex flex-wrap items-center gap-2">
                            <Button
                              htmlType="button"
                              size="default"
                              variant="primary"
                              onClick={() => void handleSaveScopes()}
                              disabled={!scopesDirty || savingScopes}
                              loading={savingScopes}
                              data-testid="cloud-org-save-repo-scopes"
                            >
                              {t("cloud.orgPanel.saveRepoScopes")}
                            </Button>
                            {scopesSaved ? (
                              <span className="text-[12px] text-success-6">
                                {t("cloud.orgPanel.repoScopesSaved")}
                              </span>
                            ) : null}
                            {scopesError ? (
                              <span className="text-[12px] text-danger-6">
                                {scopesError}
                              </span>
                            ) : null}
                          </div>
                        </SectionRow>
                      </>
                    ) : (
                      <>
                        {savedScopes.length === 0 && !coolingRowsBlock ? (
                          <SectionRow
                            label={t("cloud.orgPanel.repoScopesEmpty")}
                            light
                          />
                        ) : (
                          savedScopes.map((path) => (
                            <SectionRow
                              key={path}
                              label={<span title={path}>{path}</span>}
                              truncateLabel
                            />
                          ))
                        )}
                        {coolingRowsBlock}
                      </>
                    )}
                  </div>
                </SectionContainer>
              ) : null}

              {activeTab === CLOUD_ORG_MANAGEMENT_TAB.GENERAL && isAdmin ? (
                <CloudOrgSettingsSection
                  t={t}
                  orgName={orgName}
                  members={members}
                  currentUserId={currentUserId}
                  management={management}
                />
              ) : null}
            </div>
          )}
        </div>
      </ScrollFadeContainer>
    </div>
  );
};

export default CloudOrgPanelView;
