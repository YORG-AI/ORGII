/**
 * SessionCreatorChatPanel — Hero / Repo Display Hook
 *
 * Extracts the derived repo-display values, the org-members panel open
 * state, and the browser "add to conversation" scroll-nav shim from
 * SessionCreatorChatPanel to keep the component file under the 600-line
 * limit.
 */
import type { TFunction } from "i18next";
import { useCallback, useMemo, useState } from "react";

import type { ScrollNavState } from "@src/engines/ChatPanel/ChatHistory";
import type { UseBrowserAddToConversationActionReturn } from "@src/engines/ChatPanel/hooks/useBrowserAddToConversationAction";
import {
  SYSTEM_HOME_SOURCE_ID,
  getSystemHomeSourceLabel,
  isSystemPathSourceId,
} from "@src/features/SessionCreator/utils/systemPathSource";
import type { Repo } from "@src/store/repo";
import {
  SESSION_TARGET_KIND,
  type SessionTargetKind,
} from "@src/store/session";
import type { SessionSource } from "@src/store/session/creatorStateAtom";

import type { SessionCreatorChatPanelVariant } from "./types";

interface UseChatPanelHeroPresentationOptions {
  effectiveSource: SessionSource | null;
  repos: Repo[];
  currentRepo: Repo | undefined;
  variant: SessionCreatorChatPanelVariant;
  isOSMode: boolean;
  targetKind: SessionTargetKind;
  selectedAgentOrgId: string | null;
  browserAddToConversationNav: UseBrowserAddToConversationActionReturn;
  t: TFunction<"sessions">;
}

export function useChatPanelHeroPresentation({
  effectiveSource,
  repos,
  currentRepo,
  variant,
  isOSMode,
  targetKind,
  selectedAgentOrgId,
  browserAddToConversationNav,
  t,
}: UseChatPanelHeroPresentationOptions) {
  const sessionRepoId = effectiveSource?.repoId ?? "";
  const sessionRepo = useMemo(
    () => repos.find((repoItem) => repoItem.id === sessionRepoId),
    [repos, sessionRepoId]
  );
  const repoDisplayName = effectiveSource?.repoName ?? sessionRepo?.name;
  const effectiveBranchName = effectiveSource?.branch;
  const sessionRepoKind = sessionRepo?.kind ?? currentRepo?.kind;
  const currentRepoPath = effectiveSource?.repoPath ?? "";

  const isFullScreenVariant = variant === "fullScreen";

  const [openOrgMembersPanelId, setOpenOrgMembersPanelId] = useState<
    string | null
  >(null);
  const isOrgMembersPanelOpen =
    targetKind === SESSION_TARGET_KIND.AGENT_ORG &&
    Boolean(selectedAgentOrgId) &&
    openOrgMembersPanelId === selectedAgentOrgId;

  const handleToggleOrgMembers = useCallback(() => {
    setOpenOrgMembersPanelId((currentId) =>
      currentId === selectedAgentOrgId ? null : (selectedAgentOrgId ?? null)
    );
  }, [selectedAgentOrgId]);

  const displayedRepoId =
    isOSMode && !sessionRepoId ? SYSTEM_HOME_SOURCE_ID : sessionRepoId;
  const displayedRepoName =
    isOSMode && !repoDisplayName
      ? getSystemHomeSourceLabel(t)
      : repoDisplayName;
  const isDisplayedSystemPath = isSystemPathSourceId(displayedRepoId);

  const browserElementScrollNav = useMemo<ScrollNavState>(
    () => ({
      showScrollToBottom: false,
      onScrollToBottom: () => undefined,
      showFollowAgent: false,
      followAgentLabel: "",
      followAgentTooltipLabel: "",
      followAgentShortcut: "",
      onFollowAgent: () => undefined,
      ...browserAddToConversationNav,
    }),
    [browserAddToConversationNav]
  );

  return {
    sessionRepoId,
    effectiveBranchName,
    sessionRepoKind,
    currentRepoPath,
    isFullScreenVariant,
    isOrgMembersPanelOpen,
    handleToggleOrgMembers,
    displayedRepoId,
    displayedRepoName,
    isDisplayedSystemPath,
    browserElementScrollNav,
  };
}
