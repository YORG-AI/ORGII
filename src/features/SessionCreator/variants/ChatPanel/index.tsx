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

import {
  cliAgentCreateTuiSession,
  resolveCliTuiCommand,
} from "@src/api/tauri/agent/cliTerminalSession";
import { createHumanSession } from "@src/api/tauri/humanSession";
import { HUMAN_SESSION_TITLE_MAX_LENGTH } from "@src/api/tauri/rpc/schemas/humanSession";
import type { CliAgentType } from "@src/api/types/keys";
import Input from "@src/components/Input";
import { GHOST_INPUT_PLACEHOLDER_CLASS } from "@src/components/Input/tokens";
import Message from "@src/components/Message";
import type { ScrollNavState } from "@src/engines/ChatPanel/ChatHistory";
import { useBrowserAddToConversationAction } from "@src/engines/ChatPanel/hooks/useBrowserAddToConversationAction";
import { useSessionCreator } from "@src/engines/SessionCore/hooks/session/useSessionCreator";
import { getWorktreeFields } from "@src/engines/SessionCore/hooks/session/useSessionCreator/useSessionLaunch/launchPayload";
import type {
  SessionLaunchSuccessInfo,
  SessionLaunchWorkItemContext,
} from "@src/engines/SessionCore/hooks/session/useSessionCreator/useSessionLaunch/types";
import {
  org2CloudOrgsAtom,
  sidebarActiveCloudOrgIdAtom,
} from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import {
  SYSTEM_HOME_SOURCE_ID,
  getSystemHomeSourceLabel,
  isSystemPathSourceId,
} from "@src/features/SessionCreator/utils/systemPathSource";
import { useRepoSelection } from "@src/hooks/git/useRepoSelection";
import { createLogger } from "@src/hooks/logger";
import { useAgentOrgs } from "@src/modules/MainApp/AgentOrgs/hooks/useAgentOrgs";
import { type AgentSelection } from "@src/scaffold/GlobalSpotlight/palettes/DispatchCategoryPalette";
import { gitDependencyInstalledAtom } from "@src/store/platform/gitDependencyAtom";
import { REPO_KIND } from "@src/store/repo/types";
import {
  SESSION_TARGET_KIND,
  type WorktreeLaunchSelection,
  agentIconIdAtom,
  agentNameAtom,
  cliAgentTypeAtom,
  dispatchCategoryAtom,
  normalizeAgentOnlySessionCreatorState,
  resolveWorktreeSelectionRepoKey,
  selectedAgentDefinitionIdAtom,
  selectedAgentOrgIdAtom,
  sessionCreatorStateAtom,
  sessionSourceAtom,
  sessionTargetKindAtom,
  worktreeLaunchSelectionAtom,
} from "@src/store/session";
import { restoreToInputAtom } from "@src/store/session/cliSessionStatusAtom";
import { openCategoryPickerSignalAtom } from "@src/store/session/openCategoryPickerAtom";
import { runningLocationAtom } from "@src/store/session/runningLocationAtom";
import { loadSessions } from "@src/store/session/sessionAtom/loaders";
import { tuiModeAtom } from "@src/store/session/tuiModeAtom";
import {
  type ChatImageAttachment,
  chatImageAttachmentsAtom,
} from "@src/store/ui/chatImageAtom";
import {
  chatPanelSelectedProjectAtom,
  chatPanelSelectedProjectOrgAtom,
  chatPanelSelectedWorkItemAtom,
  modelPickerStyleAtom,
} from "@src/store/ui/chatPanelAtom";
import { draftHasContentAtom } from "@src/store/ui/draftAtom";
import { getRustAgentType } from "@src/util/session/sessionDispatch";

import { CliLaunchModeSwitch } from "../../components";
import SessionCreatorChatPanelView from "./SessionCreatorChatPanelView";
import { deriveChatPanelLaunchContext } from "./deriveLaunchContext";
import "./index.scss";
import type { SessionCreatorChatPanelSingleProps } from "./types";
import { useChatPanelAgentPresentation } from "./useChatPanelAgentPresentation";
import { useCliAgentConfiguration } from "./useCliAgentConfiguration";
import { useSessionCreatorChatPanelHandlers } from "./useSessionCreatorChatPanelHandlers";

export type { SessionCreatorChatPanelProps } from "./types";

const log = createLogger("ChatPanel");

function deriveExpectedProcess(command: string): string | undefined {
  const [binary] = command.trim().split(/\s+/);
  return binary || undefined;
}

function isCliAgentType(
  value: string | null | undefined
): value is CliAgentType {
  return Boolean(value);
}

// ── Component ─────────────────────────────────────────────────────────────────

const SessionCreatorChatPanelContent: React.FC<
  SessionCreatorChatPanelSingleProps
> = ({
  centerFullScreenContent = false,
  className = "",
  composerHeaderContent,
  innerClassName,
  footerSlot,
  leadingActionSlot,
  headerLayout = "hero",
  hideRepoLine = false,
  includeHumanSession = true,
  initialContent,
  dropdownDirection = "down",
  onOpenCliTerminal,
  onRegionNoticeChange,
  onSessionStart,
  hidePresenceButton = false,
  launchMode,
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
  const [humanTitle, setHumanTitle] = useState("");
  const humanCreatingRef = useRef(false);
  const [humanCreating, setHumanCreating] = useState(false);
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

  const runningLocation = useAtomValue(runningLocationAtom);
  const setRunningLocation = useSetAtom(runningLocationAtom);
  const worktreeLaunchSelection = useAtomValue(worktreeLaunchSelectionAtom);
  const setWorktreeLaunchSelection = useSetAtom(worktreeLaunchSelectionAtom);
  const currentWorktreeRepoKey = resolveWorktreeSelectionRepoKey(
    effectiveSource?.repoId,
    effectiveSource?.repoPath
  );
  const activeWorktreeSelection =
    worktreeLaunchSelection?.repoKey === currentWorktreeRepoKey
      ? worktreeLaunchSelection
      : null;
  const clearWorktreeLaunchSelection = useCallback(
    () => setWorktreeLaunchSelection(null),
    [setWorktreeLaunchSelection]
  );

  const handleWorktreeLocationChange = useCallback(
    (location: Parameters<typeof setRunningLocation>[0]) => {
      if (location !== "worktree") {
        setWorktreeLaunchSelection(null);
      }
      setRunningLocation(location);
    },
    [setRunningLocation, setWorktreeLaunchSelection]
  );

  const handleWorktreeSourceSelect = useCallback(
    (selection: WorktreeLaunchSelection) => {
      // A PR-base resolution may finish after the user switches repositories.
      // Ignore that late result before it can overwrite the new repo's branch
      // draft or put the creator back into worktree mode.
      if (
        !currentWorktreeRepoKey ||
        selection.repoKey !== currentWorktreeRepoKey
      ) {
        return;
      }
      setWorktreeLaunchSelection(selection);
      setRunningLocation("worktree");
      if (selection.source.baseBranch) {
        handleBranchChange(selection.source.baseBranch);
      }
    },
    [
      currentWorktreeRepoKey,
      handleBranchChange,
      setRunningLocation,
      setWorktreeLaunchSelection,
    ]
  );

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
  const workItemPanelHostRef = useRef<HTMLDivElement>(null);
  const setSessionSource = useSetAtom(sessionSourceAtom);
  const modelPickerStyle = useAtomValue(modelPickerStyleAtom);
  const [openOrgMembersPanelId, setOpenOrgMembersPanelId] = useState<
    string | null
  >(null);
  const isOrgMembersPanelOpen =
    targetKind === SESSION_TARGET_KIND.AGENT_ORG &&
    Boolean(selectedAgentOrgId) &&
    openOrgMembersPanelId === selectedAgentOrgId;

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

  useEffect(() => {
    if (!effectiveSource) return;
    if (effectiveSource.type !== "local") return;
    if (!effectiveSource.repoId) return;
    if (effectiveSource.repoId !== selectedRepoId) return;
    if (currentRepo?.kind === REPO_KIND.FOLDER) return;
    if (!currentBranch) return;
    if (effectiveSource.branch) return;

    setSessionSource({
      ...effectiveSource,
      branch: currentBranch,
    });
  }, [
    currentBranch,
    currentRepo?.kind,
    effectiveSource,
    selectedRepoId,
    setSessionSource,
  ]);

  // ── Restore text ──────────────────────────────────────────────────────────

  const restoreToInput = useAtomValue(restoreToInputAtom);
  const setImageAttachments = useSetAtom(chatImageAttachmentsAtom);
  const [initialRestoreText] = useState<string>(() => {
    return store.get(restoreToInputAtom)?.displayContent ?? "";
  });

  // ── Draft content tracking ────────────────────────────────────────────────

  const setDraftHasContent = useSetAtom(draftHasContentAtom);

  const handleContentChangeWithTracking = useCallback(
    (text: string) => {
      setDraftHasContent(text.trim().length > 0);
      setHumanNoteHasContent(text.trim().length > 0);
      handleContentChange?.(text);
    },
    [handleContentChange, setDraftHasContent]
  );

  useEffect(() => {
    if (!restoreToInput?.displayContent) return;
    const editor = composerInputRef.current;
    if (!editor) return;
    const restoredText = restoreToInput.displayContent;
    editor.setContent(restoredText);
    editor.focus();
    handleContentChangeWithTracking(restoredText);
    if (restoreToInput.imageDataUrls?.length) {
      const restoredImages: ChatImageAttachment[] =
        restoreToInput.imageDataUrls.map((dataUrl, idx) => ({
          id: `restored_${Date.now()}_${idx}`,
          dataUrl,
          fileName: `restored-image-${idx + 1}.png`,
          size: 0,
          width: 0,
          height: 0,
        }));
      setImageAttachments((prev) => [
        ...prev.filter((image) => image.ownerId),
        ...restoredImages,
      ]);
    }
    store.set(restoreToInputAtom, null);
    store.set(draftHasContentAtom, restoredText.trim().length > 0);
  }, [
    restoreToInput,
    composerInputRef,
    handleContentChangeWithTracking,
    setImageAttachments,
    store,
  ]);

  useEffect(() => {
    return () => {
      setDraftHasContent(false);
    };
  }, [setDraftHasContent]);

  // ── Launch ────────────────────────────────────────────────────────────────

  const handleLaunch = useCallback(async () => {
    if (isHumanMode) {
      const note = composerInputRef.current?.getTextWithPills().trim() ?? "";
      if (!note || humanCreatingRef.current) return;
      humanCreatingRef.current = true;
      setHumanCreating(true);
      try {
        const humanSession = await createHumanSession({
          body: note,
          title: humanTitle.trim() || undefined,
          workspacePath: effectiveSource?.repoPath,
        });
        composerInputRef.current?.clear();
        setHumanTitle("");
        handleContentChangeWithTracking("");
        await loadSessions({ forceRefresh: true }).catch(() => undefined);
        handleSessionStart({ sessionId: humanSession.sessionId });
      } catch (error) {
        Message.error(
          error instanceof Error
            ? error.message
            : t("humanSession.createFailed")
        );
      } finally {
        humanCreatingRef.current = false;
        setHumanCreating(false);
      }
      return;
    }

    if (
      isCliTuiMode &&
      onOpenCliTerminal &&
      selectedCliAgent &&
      isCliAgentType(cliAgentType)
    ) {
      const command = await resolveCliTuiCommand(
        cliAgentType,
        selectedCliAgent.command.trim()
      );
      if (command.length > 0) {
        // Back the TUI terminal with a managed session row so the worktree
        // selection is honored (cwd below) and lifecycle hooks can attribute
        // status/transcripts via ORGII_SESSION_ID. Creation failure degrades
        // to the old unbound repo-root terminal rather than blocking launch.
        const repoPath = effectiveSource?.repoPath;
        let cwd = repoPath;
        let agentSessionId: string | undefined;
        try {
          const worktreeFields = getWorktreeFields({
            runningLocation,
            repoId: effectiveSource?.repoId,
            repoPath,
            worktreeLaunchSelection,
          });
          const created = await cliAgentCreateTuiSession({
            platform: cliAgentType,
            name: selectedCliAgent.displayName,
            repoPath,
            isolate: worktreeFields.isolate,
            worktreeBaseRef: worktreeFields.worktreeBaseRef,
            worktreePath: worktreeFields.worktreePath,
            orgId: chatPanelLaunchContext.orgId,
          });
          agentSessionId = created.sessionId;
          cwd = created.worktreePath || repoPath;
        } catch (error) {
          log.warn(
            "TUI session create failed; opening unbound terminal",
            error
          );
        }
        onOpenCliTerminal({
          cliAgentType,
          command,
          title: selectedCliAgent.displayName,
          cwd,
          agentSessionId,
          expectedProcess: deriveExpectedProcess(command),
        });
        setAttachedWorkItemContext(null);
        return;
      }
    }

    return originalHandleLaunch();
  }, [
    cliAgentType,
    composerInputRef,
    chatPanelLaunchContext.orgId,
    effectiveSource?.repoId,
    effectiveSource?.repoPath,
    handleContentChangeWithTracking,
    handleSessionStart,
    humanTitle,
    isHumanMode,
    isCliTuiMode,
    onOpenCliTerminal,
    originalHandleLaunch,
    runningLocation,
    selectedCliAgent,
    setAttachedWorkItemContext,
    t,
    worktreeLaunchSelection,
  ]);

  useEffect(() => {
    if (!selectedRepoId) return;
    if (currentRepo?.kind === REPO_KIND.FOLDER) return;
    loadBranchList();
  }, [selectedRepoId, loadBranchList, currentRepo?.kind]);

  // ── Hero section ──────────────────────────────────────────────────────────

  const sessionRepoId = effectiveSource?.repoId ?? "";
  const sessionRepo = useMemo(
    () => repos.find((repoItem) => repoItem.id === sessionRepoId),
    [repos, sessionRepoId]
  );
  const repoDisplayName = effectiveSource?.repoName ?? sessionRepo?.name;
  const effectiveBranchName = effectiveSource?.branch;
  const sessionRepoKind = sessionRepo?.kind ?? currentRepo?.kind;
  const currentRepoPath = effectiveSource?.repoPath ?? "";

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

  const isFullScreenVariant = variant === "fullScreen";

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
          <div className="px-1" data-testid="create-human-session-header">
            <div className="flex h-10 items-center py-0">
              <Input
                type="text"
                value={humanTitle}
                onChange={setHumanTitle}
                placeholder={t("humanSession.titlePlaceholder")}
                maxLength={HUMAN_SESSION_TITLE_MAX_LENGTH}
                autoFocus
                disabled={humanCreating}
                fieldVariant="ghost"
                size="small"
                className="flex-1"
                inputClassName={GHOST_INPUT_PLACEHOLDER_CLASS}
                data-testid="create-human-session-title-input"
              />
            </div>
          </div>
        ) : (
          composerHeaderContent
        )
      }
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
        shellClassName: "session-creator-chat-panel-fullscreen-input-shell",
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
      innerClassName={innerClassName}
      isCategorySelectorOpen={isCategorySelectorOpen}
      isCliTuiMode={isCliTuiMode}
      isFullScreenVariant={isFullScreenVariant}
      isLoading={isHumanMode ? humanCreating : isLoading}
      isOrgMembersPanelOpen={isOrgMembersPanelOpen}
      isWingmanMode={isWingmanMode}
      leadingActionSlot={leadingActionSlot}
      onAttachedWorkItemContextChange={setAttachedWorkItemContext}
      onCategoryPickerOpen={() => setIsCategorySelectorOpen(true)}
      onFileUpload={handleFileUpload}
      onLaunch={handleLaunch}
      onShareScreen={() => handleShareScreenClick().catch(log.error)}
      onToggleOrgMembers={handleToggleOrgMembers}
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
      workItemPanelHostRef={workItemPanelHostRef}
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
