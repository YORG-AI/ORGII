import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  DEFAULT_SETUP_WALKTHROUGH_PROGRESS,
  type SetupWalkthroughProgress,
  createDefaultSetupWalkthroughProgress,
} from "@src/config/settingsSchema/setupWalkthroughProgress";
import { org2CloudSharingFloorAtom } from "@src/features/Org2Cloud/org2CloudAccessSettings";
import { refreshOrg2CloudAuthForAction } from "@src/features/Org2Cloud/org2CloudAuthAction";
import {
  type Org2CloudAuthState,
  org2CloudAuthAtom,
} from "@src/features/Org2Cloud/org2CloudAuthAtom";
import { broadcastOrgControlChangedToPeers } from "@src/features/Org2Cloud/org2CloudControlBus";
import { createCloudInvite } from "@src/features/Org2Cloud/org2CloudManagementClient";
import {
  type Org2CloudOrg,
  buildCloudOrgSelectorValue,
  org2CloudOrgsAtom,
  sidebarActiveCloudOrgIdAtom,
} from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import {
  org2CloudRepoScopesAtom,
  org2CloudSyncEnabledAtom,
} from "@src/features/Org2Cloud/org2CloudSyncAtoms";
import {
  setOrgRepoScopes,
  setOrgSharingFloor,
} from "@src/features/Org2Cloud/org2CloudSyncClient";
import { org2CloudSyncEngine } from "@src/features/Org2Cloud/org2CloudSyncEngine";
import {
  CloudOrgMembershipActionFailure,
  useCloudOrgMembershipActions,
} from "@src/features/Org2Cloud/useCloudOrgMembershipActions";
import { sidebarSelectedOrgIdAtom } from "@src/features/Organizations/sidebarOrgScopeAtom";
import { resolveShareableScopeKeys } from "@src/features/TeamCollaboration/repoScopeResolver";
import {
  dataSourceConfigAtom,
  getSourceConfig,
} from "@src/store/session/dataSourceConfigAtom";
import {
  saveSettingAtom,
  settingsAtom,
} from "@src/store/settings/settingsAtom";
import { workspaceFoldersAtom } from "@src/store/workspace";

import {
  type SetupStepId,
  advanceSetupProgress,
  applySetupOrganizationSelection,
  canNavigateToSetupStep,
  captureSetupTeamPolicy,
  getNormalizedCurrentStep,
  retreatSetupProgress,
  setupTeamPolicyMatches,
} from "./flow";
import { detectSetupTools, importCodexHistory } from "./setupCommands";
import { useSyncedSetupWalkthroughProgress } from "./useSyncedSetupWalkthroughProgress";

export type SetupOperation =
  | "detect-tools"
  | "import-history"
  | "create-org"
  | "join-org"
  | "resolve-scopes"
  | "save-policy"
  | "create-invite"
  | "verify-sync";

export function useSetupWalkthroughController() {
  const { t } = useTranslation("onboarding");
  const stored = useAtomValue(settingsAtom)["general.setupWalkthroughProgress"];
  const { progress, replaceProgress: replaceSyncedProgress } =
    useSyncedSetupWalkthroughProgress(stored);
  const progressRef = useRef(progress);
  const mountedRef = useRef(true);
  const activeOperationRef = useRef<SetupOperation | null>(null);
  const [activeOperation, setActiveOperation] = useState<SetupOperation | null>(
    null
  );
  const [operationError, setOperationError] = useState<string | null>(null);

  const saveProgress = useSetAtom(saveSettingAtom);
  const [cloudAuth, setCloudAuth] = useAtom(org2CloudAuthAtom);
  const cloudOrgs = useAtomValue(org2CloudOrgsAtom);
  const workspaceFolders = useAtomValue(workspaceFoldersAtom);
  const setSelectedOrgScope = useSetAtom(sidebarSelectedOrgIdAtom);
  const setActiveCloudOrg = useSetAtom(sidebarActiveCloudOrgIdAtom);
  const repoScopesByOrg = useAtomValue(org2CloudRepoScopesAtom);
  const sharingFloorByOrg = useAtomValue(org2CloudSharingFloorAtom);
  const setRepoScopes = useSetAtom(org2CloudRepoScopesAtom);
  const setSyncEnabled = useSetAtom(org2CloudSyncEnabledAtom);
  const setSharingFloor = useSetAtom(org2CloudSharingFloorAtom);
  const setDataSourceConfig = useSetAtom(dataSourceConfigAtom);
  const { createOrganization, joinOrganization } =
    useCloudOrgMembershipActions();

  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  const getOperationErrorMessage = useCallback(
    (error: unknown): string => {
      if (error instanceof CloudOrgMembershipActionFailure) {
        switch (error.code) {
          case "signed_out":
            return t("readiness.errors.signInRequired");
          case "session_expired":
            return t("readiness.errors.sessionExpired");
          case "invalid_invite":
            return t("readiness.errors.invalidInvite");
          case "roster_not_converged":
            return t("readiness.errors.rosterNotConverged");
          case "session_superseded":
          case "session_unavailable":
          case "unexpected_response":
            return t("readiness.errors.cloudUnavailable");
        }
      }
      return error instanceof Error
        ? error.message
        : t("readiness.errors.unknown");
    },
    [t]
  );

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    []
  );

  const replaceProgress = useCallback(
    (next: SetupWalkthroughProgress) => {
      progressRef.current = next;
      return replaceSyncedProgress(next);
    },
    [replaceSyncedProgress]
  );

  const patchProgress = useCallback(
    (patch: Partial<SetupWalkthroughProgress>) =>
      replaceProgress({ ...progressRef.current, ...patch }),
    [replaceProgress]
  );

  const persist = useCallback(
    async (next: SetupWalkthroughProgress = progressRef.current) => {
      await saveProgress({
        key: "general.setupWalkthroughProgress",
        value: next,
      });
    },
    [saveProgress]
  );

  const runAtomic = useCallback(
    async <T>(
      operation: SetupOperation,
      task: () => Promise<T>
    ): Promise<T | undefined> => {
      if (activeOperationRef.current !== null) return undefined;
      activeOperationRef.current = operation;
      setActiveOperation(operation);
      setOperationError(null);
      try {
        return await task();
      } catch (error) {
        if (mountedRef.current) {
          setOperationError(getOperationErrorMessage(error));
        }
        return undefined;
      } finally {
        activeOperationRef.current = null;
        if (mountedRef.current) setActiveOperation(null);
      }
    },
    [getOperationErrorMessage]
  );

  const selectGoal = useCallback(
    (goal: SetupWalkthroughProgress["goal"]) => {
      const resetTeam =
        goal === "team_activity"
          ? {}
          : {
              selectedOrgId: null,
              selectedOrgName: null,
              selectedOrgRole: null,
              repoScopes: [],
              inviteLink: null,
              verifiedAt: null,
            };
      patchProgress({ goal, ...resetTeam });
    },
    [patchProgress]
  );

  const selectOrganization = useCallback(
    (org: Org2CloudOrg) => {
      const current = progressRef.current;
      const scope = buildCloudOrgSelectorValue(org.orgId);
      setSelectedOrgScope(scope);
      setActiveCloudOrg(org.orgId);
      replaceProgress(
        applySetupOrganizationSelection(current, {
          orgId: org.orgId,
          name: org.name,
          role: org.role,
          repoScopes: repoScopesByOrg[org.orgId] ?? [],
          sharingFloor:
            sharingFloorByOrg[org.orgId] ??
            DEFAULT_SETUP_WALKTHROUGH_PROGRESS.sharingFloor,
        })
      );
    },
    [
      repoScopesByOrg,
      replaceProgress,
      setActiveCloudOrg,
      setSelectedOrgScope,
      sharingFloorByOrg,
    ]
  );

  const freshAuth = useCallback(async (): Promise<Org2CloudAuthState> => {
    if (!cloudAuth) {
      throw new Error(t("readiness.errors.signInRequired"));
    }
    const refreshed = await refreshOrg2CloudAuthForAction(
      cloudAuth,
      setCloudAuth
    );
    if (refreshed.status !== "ready") {
      throw new Error(
        refreshed.status === "expired"
          ? t("readiness.errors.sessionExpired")
          : t("readiness.errors.cloudUnavailable")
      );
    }
    return refreshed.auth;
  }, [cloudAuth, setCloudAuth, t]);

  const actions = {
    detectTools: () =>
      runAtomic("detect-tools", async () => {
        const tools = await detectSetupTools();
        const next = patchProgress({ tools });
        await persist(next);
        return tools;
      }),

    importHistory: () =>
      runAtomic("import-history", async () => {
        const count = await importCodexHistory();
        setDataSourceConfig((current) => ({
          ...current,
          codex_app: {
            ...getSourceConfig(current, "codex_app"),
            enabled: true,
            lastScannedAt: Date.now(),
          },
        }));
        const next = patchProgress({ historySessionCount: count });
        await persist(next);
        return count;
      }),

    createOrganization: (name: string) =>
      runAtomic("create-org", async () => {
        const org = await createOrganization(name);
        selectOrganization(org);
        await persist(progressRef.current);
        return org;
      }),

    joinOrganization: (invite: string) =>
      runAtomic("join-org", async () => {
        const org = await joinOrganization(invite);
        selectOrganization(org);
        await persist(progressRef.current);
        return org;
      }),

    resolveWorkspaceScopes: () =>
      runAtomic("resolve-scopes", async () => {
        if (workspaceFolders.length === 0) {
          throw new Error(t("readiness.errors.workspaceRequired"));
        }
        const resolved = await Promise.all(
          workspaceFolders.map((folder) =>
            resolveShareableScopeKeys(folder.path)
          )
        );
        const scopes = Array.from(
          new Set(resolved.flatMap((keys) => keys ?? []))
        );
        if (scopes.length === 0) {
          throw new Error(t("readiness.errors.gitRemoteRequired"));
        }
        const next = patchProgress({
          repoScopes: scopes,
          verifiedAt: null,
        });
        await persist(next);
        return scopes;
      }),

    saveTeamPolicy: () =>
      runAtomic("save-policy", async () => {
        const snapshot = captureSetupTeamPolicy(progressRef.current);
        if (!snapshot || snapshot.repoScopes.length === 0) {
          throw new Error(t("readiness.errors.orgAndScopeRequired"));
        }
        const auth = await freshAuth();
        await setOrgRepoScopes(
          auth.accessToken,
          snapshot.selectedOrgId,
          snapshot.repoScopes
        );
        setRepoScopes((previous) => ({
          ...previous,
          [snapshot.selectedOrgId]: snapshot.repoScopes,
        }));
        setSyncEnabled((previous) => ({
          ...previous,
          [snapshot.selectedOrgId]: true,
        }));
        broadcastOrgControlChangedToPeers(snapshot.selectedOrgId, "scopes");

        await setOrgSharingFloor(
          auth.accessToken,
          snapshot.selectedOrgId,
          snapshot.sharingFloor
        );
        setSharingFloor((previous) => ({
          ...previous,
          [snapshot.selectedOrgId]: snapshot.sharingFloor,
        }));
        broadcastOrgControlChangedToPeers(
          snapshot.selectedOrgId,
          "entitlement"
        );
        await org2CloudSyncEngine.runSyncPassAndWaitForDrain();
        if (!setupTeamPolicyMatches(progressRef.current, snapshot)) {
          throw new Error(t("readiness.errors.policyChanged"));
        }
        const next = patchProgress({ verifiedAt: Date.now() });
        await persist(next);
      }),

    createInvite: () =>
      runAtomic("create-invite", async () => {
        const orgId = progressRef.current.selectedOrgId;
        if (!orgId) throw new Error(t("readiness.errors.orgRequired"));
        const auth = await freshAuth();
        const expiresAt = new Date(
          Date.now() + 7 * 24 * 60 * 60 * 1000
        ).toISOString();
        const invite = await createCloudInvite(auth.accessToken, {
          orgId,
          role: "member",
          maxUses: 25,
          expiresAt,
        });
        if (progressRef.current.selectedOrgId !== orgId) {
          throw new Error(t("readiness.errors.inviteOrgChanged"));
        }
        const next = patchProgress({ inviteLink: invite.inviteLink });
        await persist(next);
        return invite.inviteLink;
      }),

    verifySync: () =>
      runAtomic("verify-sync", async () => {
        const orgId = progressRef.current.selectedOrgId;
        if (!orgId) throw new Error(t("readiness.errors.orgRequired"));
        setSyncEnabled((previous) => ({
          ...previous,
          [orgId]: true,
        }));
        await org2CloudSyncEngine.resumeOrgAndWait(orgId);
        if (progressRef.current.selectedOrgId !== orgId) {
          throw new Error(t("readiness.errors.syncOrgChanged"));
        }
        const next = patchProgress({ verifiedAt: Date.now() });
        await persist(next);
      }),
  };

  const goNext = useCallback(async () => {
    const next = advanceSetupProgress(progressRef.current);
    if (next === progressRef.current) return false;
    replaceProgress(next);
    await persist(next);
    return true;
  }, [persist, replaceProgress]);

  const goBack = useCallback(async () => {
    const next = retreatSetupProgress(progressRef.current);
    replaceProgress(next);
    await persist(next);
  }, [persist, replaceProgress]);

  const goToStep = useCallback(
    async (stepId: SetupStepId) => {
      if (!canNavigateToSetupStep(progressRef.current, stepId)) return;
      const next = patchProgress({ currentStepId: stepId });
      await persist(next);
    },
    [patchProgress, persist]
  );

  const reset = useCallback(async () => {
    const next = createDefaultSetupWalkthroughProgress();
    replaceProgress(next);
    await persist(next);
  }, [persist, replaceProgress]);

  return {
    progress,
    currentStepId: getNormalizedCurrentStep(progress),
    cloudAuth,
    cloudOrgs,
    workspaceFolders,
    activeOperation,
    operationError,
    setOperationError,
    patchProgress,
    persist,
    selectGoal,
    selectOrganization,
    goNext,
    goBack,
    goToStep,
    reset,
    actions,
  };
}

export type SetupWalkthroughController = ReturnType<
  typeof useSetupWalkthroughController
>;
