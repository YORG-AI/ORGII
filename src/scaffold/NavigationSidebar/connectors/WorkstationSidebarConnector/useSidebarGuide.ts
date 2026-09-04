import type { TFunction } from "i18next";
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useMemo, useRef } from "react";

import { normalizeSidebarGuideProgress } from "@src/config/settingsSchema/sidebarGuideProgress";
import { createLogger } from "@src/hooks/logger";
import { openCollabOrgSpotlight } from "@src/scaffold/GlobalSpotlight/openSpotlight";
import {
  openOrganizationInChatPanelTabAtom,
  openRuntimeInChatPanelTabAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import { settingsAtom } from "@src/store/settings/settingsAtom";
import {
  SETUP_GUIDE_PERSISTED_MILESTONE,
  completeSetupGuideMilestone,
  dismissSetupGuide,
  hasCompletedSetupGuideMilestone,
} from "@src/store/settings/setupGuideProgress";
import { saveSetupGuideProgressAtom } from "@src/store/settings/setupGuideProgressAtom";
import { CLOUD_ORG_MANAGEMENT_VIEW } from "@src/store/ui/chatPanelAtom";
import { showGuideHighlightAtom } from "@src/store/ui/guideHighlightAtom";
import { runtimeNavigationIntentAtom } from "@src/store/ui/runtimeNavigationAtom";

import type SidebarOrgSelector from "../SidebarOrgSelector";
import {
  SIDEBAR_GUIDE_MILESTONE,
  type SidebarGuideCompletion,
} from "../sidebarGuideProgress";
import type { useWorkstationSidebarScopeAndPagination } from "./sidebarConnector.scopeAndPagination";
import { resolveSidebarGuideInviteSpotlight } from "./sidebarGuideInviteNavigation";
import { resolveSidebarGuideOrganizationNavigation } from "./sidebarGuideOrganizationNavigation";
import { startSidebarGuideProductTour } from "./sidebarGuideProductTour";
import { resolveSidebarGuideTeamUsageNavigation } from "./sidebarGuideTeamUsageNavigation";

const logger = createLogger("WorkstationSidebarGuide");

type Scope = ReturnType<typeof useWorkstationSidebarScopeAndPagination>;
interface SidebarGuideParams {
  t: TFunction<"navigation">;
  guideCloudOrg: Scope["manageableCloudOrg"];
  activeOrgId: Scope["activeOrgId"];
  orgSelectorOptions: Parameters<typeof SidebarOrgSelector>[0]["options"];
  sessionCount: number;
  runtimeLabel: string;
}

/** Mounted with the sidebar, including when the guide is dismissed. */
export function useSidebarGuide({
  t,
  guideCloudOrg,
  activeOrgId,
  orgSelectorOptions,
  sessionCount,
  runtimeLabel,
}: SidebarGuideParams) {
  const openOrganizationTab = useSetAtom(openOrganizationInChatPanelTabAtom);
  const openRuntimeTab = useSetAtom(openRuntimeInChatPanelTabAtom);
  const setupGuideProgress = normalizeSidebarGuideProgress(
    useAtomValue(settingsAtom)["general.setupWalkthroughProgress"]
  );
  const saveSetupGuideProgress = useSetAtom(saveSetupGuideProgressAtom);
  const showGuideHighlight = useSetAtom(showGuideHighlightAtom);
  const setRuntimeNavigationIntent = useSetAtom(runtimeNavigationIntentAtom);
  const guideNavigationRequestId = useRef(0);
  const handleGuideConnectOrganization = useCallback(() => {
    const navigation = resolveSidebarGuideOrganizationNavigation();
    openCollabOrgSpotlight(navigation.context);
    showGuideHighlight({
      targetId: navigation.spotlight.targetId,
      title: t("sidebar.guide.connectOrganization"),
      message: t(navigation.spotlight.messageKey),
    });
  }, [showGuideHighlight, t]);

  const handleGuideInviteTeammate = useCallback(() => {
    if (!guideCloudOrg) {
      handleGuideConnectOrganization();
      return;
    }
    guideNavigationRequestId.current = Math.max(
      guideNavigationRequestId.current + 1,
      Date.now()
    );
    openOrganizationTab({
      organization: {
        kind: "cloud",
        cloudOrg: {
          orgId: guideCloudOrg.orgId,
          initialView: CLOUD_ORG_MANAGEMENT_VIEW.MEMBERS,
          initialViewRequestId: guideNavigationRequestId.current,
        },
      },
      title: t("collaboration.manageOrg"),
    });
    const spotlight = resolveSidebarGuideInviteSpotlight(guideCloudOrg.role);
    showGuideHighlight({
      targetId: spotlight.targetId,
      title: t("sidebar.guide.inviteTeammate"),
      message: t(spotlight.messageKey),
    });
  }, [
    handleGuideConnectOrganization,
    guideCloudOrg,
    openOrganizationTab,
    showGuideHighlight,
    t,
  ]);

  const handleGuideExploreProduct = useCallback(() => {
    startSidebarGuideProductTour();
    void saveSetupGuideProgress((progress) =>
      completeSetupGuideMilestone(
        progress,
        SETUP_GUIDE_PERSISTED_MILESTONE.PRODUCT_TOUR_STARTED
      )
    ).catch((error: unknown) => {
      logger.warn("failed to persist product tour guide milestone", error);
    });
  }, [saveSetupGuideProgress]);

  const handleGuideDismiss = useCallback(() => {
    void saveSetupGuideProgress(dismissSetupGuide).catch((error: unknown) => {
      logger.warn("failed to persist setup guide dismissal", error);
    });
  }, [saveSetupGuideProgress]);

  const handleGuideViewTeamUsage = useCallback(() => {
    guideNavigationRequestId.current = Math.max(
      guideNavigationRequestId.current + 1,
      Date.now()
    );
    const navigation = resolveSidebarGuideTeamUsageNavigation(
      guideNavigationRequestId.current,
      guideCloudOrg?.orgId
    );
    if (!navigation) {
      handleGuideConnectOrganization();
      return;
    }
    setRuntimeNavigationIntent(navigation.intent);
    openRuntimeTab(runtimeLabel);
    showGuideHighlight({
      targetId: navigation.spotlight.targetId,
      title: t("sidebar.guide.viewTeamActivity"),
      message: t(navigation.spotlight.messageKey),
    });
    void saveSetupGuideProgress((progress) =>
      completeSetupGuideMilestone(
        progress,
        SETUP_GUIDE_PERSISTED_MILESTONE.TEAM_ACTIVITY_VIEWED
      )
    ).catch((error: unknown) => {
      logger.warn("failed to persist team usage guide milestone", error);
    });
  }, [
    guideCloudOrg,
    handleGuideConnectOrganization,
    openRuntimeTab,
    runtimeLabel,
    saveSetupGuideProgress,
    setRuntimeNavigationIntent,
    showGuideHighlight,
    t,
  ]);

  const guideCompletion = useMemo<SidebarGuideCompletion>(
    () => ({
      [SIDEBAR_GUIDE_MILESTONE.SESSION]: sessionCount > 0,
      [SIDEBAR_GUIDE_MILESTONE.ORGANIZATION]: Boolean(guideCloudOrg),
      [SIDEBAR_GUIDE_MILESTONE.TEAMMATE]: hasCompletedSetupGuideMilestone(
        setupGuideProgress,
        SETUP_GUIDE_PERSISTED_MILESTONE.TEAMMATE_INVITED
      ),
      [SIDEBAR_GUIDE_MILESTONE.TEAM_USAGE]: hasCompletedSetupGuideMilestone(
        setupGuideProgress,
        SETUP_GUIDE_PERSISTED_MILESTONE.TEAM_ACTIVITY_VIEWED
      ),
      [SIDEBAR_GUIDE_MILESTONE.PRODUCT_TOUR]: hasCompletedSetupGuideMilestone(
        setupGuideProgress,
        SETUP_GUIDE_PERSISTED_MILESTONE.PRODUCT_TOUR_STARTED
      ),
    }),
    [guideCloudOrg, sessionCount, setupGuideProgress]
  );

  const guideScopeLabel = useMemo(() => {
    const activeOption = orgSelectorOptions.find(
      (option) => String(option.value) === String(activeOrgId)
    );
    return typeof activeOption?.label === "string"
      ? activeOption.label
      : t("sidebar.guide.localWorkspace");
  }, [activeOrgId, orgSelectorOptions, t]);

  return {
    completion: guideCompletion,
    dismissed: setupGuideProgress.dismissed,
    scopeLabel: guideScopeLabel,
    onDismiss: handleGuideDismiss,
    onConnectOrganization: handleGuideConnectOrganization,
    onInviteTeammate: handleGuideInviteTeammate,
    onViewTeamUsage: handleGuideViewTeamUsage,
    onExploreProduct: handleGuideExploreProduct,
  };
}
