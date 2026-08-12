import { useAtomValue, useSetAtom, useStore } from "jotai";
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { useBrowserAddToConversationAction } from "@src/engines/ChatPanel/hooks/useBrowserAddToConversationAction";
import { useSessionCreator } from "@src/engines/SessionCore/hooks/session/useSessionCreator";
import type {
  SessionLaunchSuccessInfo,
  SessionLaunchWorkItemContext,
} from "@src/engines/SessionCore/hooks/session/useSessionCreator/useSessionLaunch/types";
import {
  org2CloudOrgsAtom,
  sidebarActiveCloudOrgIdAtom,
} from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import { useRepoSelection } from "@src/hooks/git/useRepoSelection";
import { createLogger } from "@src/hooks/logger";
import { useAgentOrgs } from "@src/modules/MainApp/AgentOrgs/hooks/useAgentOrgs";
import { type AgentSelection } from "@src/scaffold/GlobalSpotlight/palettes/DispatchCategoryPalette";
import { gitDependencyInstalledAtom } from "@src/store/platform/gitDependencyAtom";
import {
  SESSION_TARGET_KIND,
  agentIconIdAtom,
  agentNameAtom,
  cliAgentTypeAtom,
  dispatchCategoryAtom,
  normalizeAgentOnlySessionCreatorState,
  selectedAgentDefinitionIdAtom,
  selectedAgentOrgIdAtom,
  sessionCreatorStateAtom,
  sessionTargetKindAtom,
} from "@src/store/session";
import { openCategoryPickerSignalAtom } from "@src/store/session/openCategoryPickerAtom";
import { tuiModeAtom } from "@src/store/session/tuiModeAtom";
import {
  chatPanelSelectedProjectAtom,
  chatPanelSelectedProjectOrgAtom,
  chatPanelSelectedWorkItemAtom,
  modelPickerStyleAtom,
} from "@src/store/ui/chatPanelAtom";
import { getRustAgentType } from "@src/util/session/sessionDispatch";

import { CliLaunchModeSwitch } from "../../components";
import ChatPanelHumanSessionHeader from "./ChatPanelHumanSessionHeader";
import SessionCreatorChatPanelView from "./SessionCreatorChatPanelView";
import { deriveChatPanelLaunchContext } from "./deriveLaunchContext";
import "./index.scss";
import type { SessionCreatorChatPanelSingleProps } from "./types";
import { useChatPanelAgentPresentation } from "./useChatPanelAgentPresentation";
import { useChatPanelBranchSync } from "./useChatPanelBranchSync";
import { useChatPanelDraftRestore } from "./useChatPanelDraftRestore";
import { useChatPanelHeroPresentation } from "./useChatPanelHeroPresentation";
import { useChatPanelLaunch } from "./useChatPanelLaunch";
import { useChatPanelWorktreeSelection } from "./useChatPanelWorktreeSelection";
import { useCliAgentConfiguration } from "./useCliAgentConfiguration";
import { useSessionCreatorChatPanelHandlers } from "./useSessionCreatorChatPanelHandlers";

export type { SessionCreatorChatPanelProps } from "./types";

const log = createLogger("ChatPanel");

// ── Component ─────────────────────────────────────────────────────────────────

const SessionCreatorChatPanelContent: React.FC<
  SessionCreatorChatPanelSingleProps
> = ({
  centerFullScreenContent = false,
  className = "",
  composerHeaderContent,
  heroFooterSlot,
  pinnedActionsContent,
  innerClassName,
  footerSlot,
  leadingActionSlot,
  headerLayout = "hero",
  hideRepoLine = false,
  hideWorkItemAttachmentControl = false,
  includeHumanSession = true,
  initialContent,
  dropdownDirection = "down",
  onCreateWorkItem,
  onOpenCliTerminal,
  onRegionNoticeChange,
  onSessionStart,
  hidePresenceButton = false,
  launchMode,
  layout = "default",
  variant = "default",
  workItemContext,
  resolveWorkItemContext,
}) => {
  const { t } = useTranslation("sessions");
  const browserAddToConversationNav = useBrowserAddToConversationAction();
  const { orgs } = useAgentOrgs();

  // Read atoms needed before useSessionCreator so we can pass derived values in.
  const dispatchCategory = useAtomValue(dispatchCategoryAtom);
  const cliAgentType = useAtomValue(cliAgentTypeAtom);
  const isCliMode = dispatchCategory === "cli_agent";
  const isHumanMode = dispatchCategory === "human_session";
  const [humanNoteHasContent, setHumanNoteHasContent] = useState(
    Boolean(initialContent?.trim())
  );
  const {
    cliComposerEnabled,
    cliLaunchMode,
    defaultTuiMode,
    enabledCliAgentList,
    handleCliLaunchModeChange,
    selectedCliAgent,
    selectedCliAgentGuiSupportKnown,
    selectedCliAgentSupportsGui,
    selectedCliVersion,
    setAgentSelectionLaunchMode,
    setDismissedCliVersionAlertKey,
    showCliVersionOutdatedAlert,
    cliVersionOutdatedAlertKey,
  } = useCliAgentConfiguration({ cliAgentType, isCliMode });

  const {
    repos: reposList,
    selectedRepoId,
    selectRepo,
    currentRepo,
    currentBranch,
    branchLoading,
    loadBranchList,
    forceRefreshRepos,
  } = useRepoSelection({ autoLoad: true });
  const [attachedWorkItemContext, setAttachedWorkItemContext] =
    useState<SessionLaunchWorkItemContext | null>(null);
  const selectedProjectOrgContext = useAtomValue(
    chatPanelSelectedProjectOrgAtom
  );
  const selectedProjectContext = useAtomValue(chatPanelSelectedProjectAtom);
  const selectedWorkItemContext = useAtomValue(chatPanelSelectedWorkItemAtom);
  const activeCloudOrgId = useAtomValue(sidebarActiveCloudOrgIdAtom);
  const cloudOrgs = useAtomValue(org2CloudOrgsAtom);
  const activeCloudOrg = useMemo(
    () => cloudOrgs.find((org) => org.orgId === activeCloudOrgId) ?? null,
    [activeCloudOrgId, cloudOrgs]
  );
  const chatPanelLaunchContext = useMemo(
    () =>
      deriveChatPanelLaunchContext({
        activeCloudOrg,
        selectedProjectContext,
        selectedProjectOrgContext,
        selectedWorkItemContext,
      }),
    [
      activeCloudOrg,
      selectedProjectContext,
      selectedProjectOrgContext,
      selectedWorkItemContext,
    ]
  );
  const store = useStore();

  const handleSessionStart = useCallback(
    (info: SessionLaunchSuccessInfo) => {
      setAttachedWorkItemContext(null);
      if (defaultTuiMode && !isHumanMode) {
        store.set(tuiModeAtom(info.sessionId), true);
      }
      onSessionStart?.(info);
    },
    [
      onSessionStart,
      defaultTuiMode,
      isHumanMode,
      setAttachedWorkItemContext,
      store,
    ]
  );

  const {
    fileInputRef,
    composerInputRef,
    uploadedFiles,
    isLoading,
    advancedConfig,
    setAdvancedConfig,
    effectiveSource,
    repos,
    showContextMenu,
    setShowContextMenu,
    atSearchQuery,
    setAtSearchQuery,
    handleFileUpload,
    handleRemoveFile,
    handleUploadClick,
    handleContentChange,
    handleAtMention,
    handleAtMentionClose,
    handleAtMentionClick,
    handleAtSelect,
    handleLaunch: originalHandleLaunch,
    handleBranchChange,
    attachedImages,
    handleImagePaste,
    removeImage,
    canLaunch,
    slashCommandKeyboardHandlerRef,
    showSlashMenu,
    slashQuery,
    handleSlashCommand,
    handleSlashCommandClose,
    handleSlashSelect,
    handleModeSelect,
    currentMode,
    includeProjectMode,
    filteredSlashItems,
    slashLoading,
  } = useSessionCreator({
    initialContent,
    launchMode,
    persistDraft: !initialContent,
    skipDraftLoading: Boolean(initialContent),
    workItemContext:
      attachedWorkItemContext ?? workItemContext ?? chatPanelLaunchContext,
    resolveWorkItemContext,
    onLaunchSuccess: handleSessionStart,
    cliAgentSupportsGui: cliComposerEnabled,
  });

  const gitInstalled = useAtomValue(gitDependencyInstalledAtom);
  const showMissingGitAlert = gitInstalled === false;
  const targetKind = useAtomValue(sessionTargetKindAtom);
  const selectedAgentDefId = useAtomValue(selectedAgentDefinitionIdAtom);
  const selectedAgentOrgId = useAtomValue(selectedAgentOrgIdAtom);
  const agentName = useAtomValue(agentNameAtom);
  const agentIconId = useAtomValue(agentIconIdAtom);

  const {
    runningLocation,
    activeWorktreeSelection,
    clearWorktreeLaunchSelection,
    handleWorktreeLocationChange,
    handleWorktreeSourceSelect,
  } = useChatPanelWorktreeSelection({ effectiveSource, handleBranchChange });

  const agentVariant = getRustAgentType(selectedAgentDefId);
  const isRustMode = dispatchCategory === "rust_agent";
  const isOSMode = isRustMode && agentVariant === "os";
  const isSDEMode = isRustMode && agentVariant === "sde";
  const isWingmanMode = isRustMode && agentVariant === "wingman";
  const isCursorIdeMode = dispatchCategory === "cursor_ide";
  const isCliTuiMode = isCliMode && !cliComposerEnabled;

  const [isCategorySelectorOpen, setIsCategorySelectorOpen] = useState(false);
  const openCategoryPickerSignal = useAtomValue(openCategoryPickerSignalAtom);
  const prevOpenCategoryPickerSignalRef = useRef(openCategoryPickerSignal);
  useEffect(() => {
    if (openCategoryPickerSignal !== prevOpenCategoryPickerSignalRef.current) {
      prevOpenCategoryPickerSignalRef.current = openCategoryPickerSignal;
      // Defer out of the effect body to avoid synchronous setState cascades
      queueMicrotask(() => setIsCategorySelectorOpen(true));
    }
  }, [openCategoryPickerSignal]);

  const agentHeroRef = useRef<HTMLButtonElement>(null);
  const modelPickerStyle = useAtomValue(modelPickerStyleAtom);

  // ── Handlers via extracted hook ───────────────────────────────────────────

  const {
    screenPickerMonitors,
    setScreenPickerMonitors,
    handleShareScreenClick,
    handleScreenPicked,
    handleRepoChange,
    handleRepoSelectForSession,
    requestModelOpen,
    setRequestModelOpen,
    handleCategorySelect,
  } = useSessionCreatorChatPanelHandlers({
    reposList,
    effectiveSource,
    advancedConfig,
    setAdvancedConfig,
    selectRepo,
    forceRefreshRepos,
    onRepoScopeChange: clearWorktreeLaunchSelection,
  });

  const handleAgentPickerSelect = useCallback(
    (selection: AgentSelection) => {
      if (selection.cliAgentType && selection.cliLaunchMode) {
        setAgentSelectionLaunchMode(selection.cliLaunchMode);
      }
      handleCategorySelect(selection);
    },
    [handleCategorySelect, setAgentSelectionLaunchMode]
  );

  const handleAdvancedConfigChange = useCallback(
    (config: typeof advancedConfig) => {
      setAdvancedConfig(config);
    },
    [setAdvancedConfig]
  );

  useChatPanelBranchSync({
    effectiveSource,
    selectedRepoId,
    currentRepoKind: currentRepo?.kind,
    currentBranch,
    loadBranchList,
  });

  const { handleContentChangeWithTracking, initialRestoreText } =
    useChatPanelDraftRestore({
      composerInputRef,
      handleContentChange,
      setHumanNoteHasContent,
    });

  const { handleLaunch, humanTitle, setHumanTitle, humanCreating } =
    useChatPanelLaunch({
      isHumanMode,
      isCliTuiMode,
      composerInputRef,
      effectiveSource,
      handleContentChangeWithTracking,
      handleSessionStart,
      onOpenCliTerminal,
      selectedCliAgent,
      cliAgentType,
      chatPanelLaunchContext,
      originalHandleLaunch,
      setAttachedWorkItemContext,
      t,
    });

  // ── Hero section ──────────────────────────────────────────────────────────

  const {
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
  } = useChatPanelHeroPresentation({
    effectiveSource,
    repos,
    currentRepo,
    variant,
    isOSMode,
    targetKind,
    selectedAgentOrgId,
    browserAddToConversationNav,
    t,
  });

  const {
    allAgentDefinitions,
    compactHeaderIcon,
    heroContent,
    heroIcon,
    selectedOrg,
  } = useChatPanelAgentPresentation({
    advancedConfig,
    agentIconId,
    agentName,
    cliAgentType,
    dispatchCategory,
    isCliMode,
    isCursorIdeMode,
    isOSMode,
    isRustMode,
    onRegionNoticeChange,
    orgs,
    selectedAgentDefId,
    selectedAgentOrgId,
    targetKind,
  });

  return (
    <SessionCreatorChatPanelView
      agentHeroRef={agentHeroRef}
      browserElementScrollNav={browserElementScrollNav}
      canLaunch={isHumanMode ? humanNoteHasContent : canLaunch}
      centerFullScreenContent={centerFullScreenContent}
      className={className}
      cliLaunchModeSwitch={
        isCliMode ? (
          <CliLaunchModeSwitch
            mode={cliLaunchMode}
            supportsGui={
              !selectedCliAgentGuiSupportKnown || selectedCliAgentSupportsGui
            }
            onModeChange={handleCliLaunchModeChange}
          />
        ) : null
      }
      cliVersionAlert={
        showCliVersionOutdatedAlert
          ? {
              cliDisplayName:
                selectedCliAgent?.displayName ?? cliAgentType ?? undefined,
              installedVersion:
                selectedCliVersion?.installed_version ?? undefined,
              latestVersion: selectedCliVersion?.latest_version ?? undefined,
              onClose: () =>
                setDismissedCliVersionAlertKey(cliVersionOutdatedAlertKey),
            }
          : undefined
      }
      compactHeaderIcon={compactHeaderIcon}
      composerHeaderContent={
        isHumanMode ? (
          <ChatPanelHumanSessionHeader
            humanTitle={humanTitle}
            setHumanTitle={setHumanTitle}
            humanCreating={humanCreating}
            t={t}
          />
        ) : (
          composerHeaderContent
        )
      }
      heroFooterSlot={heroFooterSlot}
      composerInputRef={composerInputRef}
      editorAreaProps={{
        variant: "chatPanelFullScreen",
        uploadedFiles: isHumanMode ? [] : uploadedFiles,
        onRemoveFile: handleRemoveFile,
        composerInputRef,
        onContentChange: handleContentChangeWithTracking,
        onAtMention: handleAtMention,
        onAtMentionClose: handleAtMentionClose,
        onSubmit: handleLaunch,
        showContextMenu,
        setShowContextMenu,
        atSearchQuery,
        setAtSearchQuery,
        onAtSelect: handleAtSelect,
        repoPath: currentRepoPath,
        onAtMentionClick: handleAtMentionClick,
        onUploadClick: isHumanMode ? () => undefined : handleUploadClick,
        isLoading: isHumanMode ? humanCreating : isLoading,
        onLaunch: handleLaunch,
        advancedConfig,
        onAdvancedConfigChange: handleAdvancedConfigChange,
        hideInfoLine: true,
        repoId: displayedRepoId,
        repoName: displayedRepoName,
        repoKind: isOSMode && !sessionRepoId ? undefined : currentRepo?.kind,
        branchName:
          isOSMode && !sessionRepoId ? undefined : effectiveBranchName,
        onBranchChange: handleBranchChange,
        onImagePaste: isHumanMode ? undefined : handleImagePaste,
        attachedImages: isHumanMode ? [] : attachedImages,
        onRemoveImage: isHumanMode ? undefined : removeImage,
        launchDisabled: isHumanMode ? !humanNoteHasContent : !canLaunch,
        launchAriaLabel: isHumanMode
          ? t("humanSession.createAction")
          : undefined,
        hideModelSourcePill: isHumanMode,
        editorPlaceholder: isHumanMode
          ? t("humanSession.createPlaceholder")
          : undefined,
        requestModelOpen: isHumanMode ? false : requestModelOpen,
        onModelOpenHandled: () => setRequestModelOpen(false),
        shellClassName: `session-creator-chat-panel-fullscreen-input-shell ${
          layout === "launchpad" ? "composer-breathing" : ""
        }`.trim(),
        initialContent: initialRestoreText || initialContent || undefined,
        autoFocus: !isHumanMode,
        showSlashMenu,
        slashQuery,
        slashCommandKeyboardHandlerRef,
        onSlashCommand: handleSlashCommand,
        onSlashCommandClose: handleSlashCommandClose,
        onSlashSelect: handleSlashSelect,
        onModeSelect: handleModeSelect,
        currentMode,
        includeProjectMode: isHumanMode ? false : includeProjectMode,
        filteredSlashItems,
        slashLoading,
        dropdownDirection,
      }}
      fileInputRef={fileInputRef}
      footerSlot={footerSlot}
      headerLayout={headerLayout}
      heroContent={heroContent}
      heroIcon={heroIcon}
      hidePresenceButton={hidePresenceButton}
      hideRepoLine={hideRepoLine}
      hideWorkItemAttachmentControl={hideWorkItemAttachmentControl}
      innerClassName={innerClassName}
      isCategorySelectorOpen={isCategorySelectorOpen}
      isCliTuiMode={isCliTuiMode}
      isFullScreenVariant={isFullScreenVariant}
      isLoading={isHumanMode ? humanCreating : isLoading}
      isLaunchpadLayout={layout === "launchpad"}
      isOrgMembersPanelOpen={isOrgMembersPanelOpen}
      isWingmanMode={isWingmanMode}
      leadingActionSlot={leadingActionSlot}
      onAttachedWorkItemContextChange={setAttachedWorkItemContext}
      onCategoryPickerOpen={() => setIsCategorySelectorOpen(true)}
      onCreateWorkItem={onCreateWorkItem}
      onFileUpload={handleFileUpload}
      onLaunch={handleLaunch}
      onShareScreen={() => handleShareScreenClick().catch(log.error)}
      onToggleOrgMembers={handleToggleOrgMembers}
      pinnedActionsContent={isHumanMode ? undefined : pinnedActionsContent}
      orgMembersPanelProps={
        selectedOrg
          ? {
              org: selectedOrg,
              advancedConfig,
              onAdvancedConfigChange: handleAdvancedConfigChange,
              allAgents: allAgentDefinitions,
              cliAgents: enabledCliAgentList,
            }
          : undefined
      }
      categoryPickerProps={{
        includeHumanSession,
        modelPickerStyle,
        onClose: () => setIsCategorySelectorOpen(false),
        onSelect: handleAgentPickerSelect,
        currentCategory: dispatchCategory,
        currentAgentDefinitionId: selectedAgentDefId ?? undefined,
        currentAgentOrgId: selectedAgentOrgId ?? undefined,
        currentCliAgentType: cliAgentType ?? undefined,
        anchorRef: agentHeroRef,
      }}
      screenPickerProps={
        screenPickerMonitors
          ? {
              monitors: screenPickerMonitors,
              onSelect: handleScreenPicked,
              onClose: () => setScreenPickerMonitors(null),
            }
          : undefined
      }
      sessionInfoProps={{
        repoId: displayedRepoId,
        repoName: displayedRepoName,
        repoPath: currentRepoPath,
        onRepoChange: handleRepoChange,
        onRepoSelect: handleRepoSelectForSession,
        repoKind: sessionRepoKind,
        includeSystemPaths: isOSMode || isSDEMode,
        branchName:
          isOSMode && !sessionRepoId ? undefined : effectiveBranchName,
        branchLoading: branchLoading && !effectiveBranchName,
        onBranchChange: handleBranchChange,
        worktreeLocation: isDisplayedSystemPath ? undefined : runningLocation,
        worktreeSourceLabel:
          runningLocation === "worktree"
            ? activeWorktreeSelection?.source.label
            : undefined,
        selectedWorktreePath:
          activeWorktreeSelection?.source.existingWorktreePath ?? null,
        onWorktreeLocationChange: handleWorktreeLocationChange,
        onWorktreeSourceSelect: handleWorktreeSourceSelect,
        fullWidth: true,
        pillVariant: headerLayout === "compact" ? "ghost" : undefined,
      }}
      showMissingGitAlert={!isHumanMode && showMissingGitAlert}
      hideSessionSetupControls={isHumanMode}
      workItemContext={attachedWorkItemContext}
    />
  );
};

const SessionCreatorChatPanelSingle: React.FC<
  SessionCreatorChatPanelSingleProps
> = (props) => {
  const creatorState = useAtomValue(sessionCreatorStateAtom);
  const setCreatorState = useSetAtom(sessionCreatorStateAtom);
  const shouldResetHumanSelection =
    props.includeHumanSession === false &&
    (creatorState.dispatchCategory === "human_session" ||
      creatorState.targetKind === SESSION_TARGET_KIND.HUMAN);

  useLayoutEffect(() => {
    if (!shouldResetHumanSelection) return;
    setCreatorState((previous) =>
      normalizeAgentOnlySessionCreatorState(previous)
    );
  }, [setCreatorState, shouldResetHumanSelection]);

  if (shouldResetHumanSelection) return null;

  return <SessionCreatorChatPanelContent {...props} />;
};

SessionCreatorChatPanelSingle.displayName = "SessionCreatorChatPanelSingle";

export default SessionCreatorChatPanelSingle;
