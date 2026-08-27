import {
  Airplay,
  BellOff,
  CircleArrowUp,
  Network,
  RefreshCw,
} from "lucide-react";
import React, { Children, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { DispatchCategory } from "@src/api/tauri/session";
import type { CliAgentType } from "@src/api/types/keys";
import Button from "@src/components/Button";
import type { ComposerInputRef } from "@src/components/ComposerInput";
import { pillControlStateClass } from "@src/components/CompoundPill/config";
import InlineAlert from "@src/components/InlineAlert";
import SelectorPill from "@src/components/SelectorPill";
import { COMPOSER_HORIZONTAL_GUTTER_CLASS } from "@src/config/composerStackTokens";
import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";
import type { ScrollNavState } from "@src/engines/ChatPanel/ChatHistory";
import CollapsedInlineRow from "@src/engines/ChatPanel/InputArea/components/CollapsedInlineRow";
import PinnedActionsBar from "@src/engines/ChatPanel/InputArea/components/PinnedActionsBar";
import { usePinnedActionsVisibilityContextMenu } from "@src/engines/ChatPanel/InputArea/components/PinnedActionsBar/usePinnedActionsVisibilityContextMenu";
import type { SessionLaunchWorkItemContext } from "@src/engines/SessionCore/hooks/session/useSessionCreator/useSessionLaunch/types";
import { LaunchpadActionGrid } from "@src/features/SessionCreator/components/LaunchpadActionGrid";
import {
  CREATOR_BOTTOM_DOCK_PADDING_CLASS,
  CREATOR_MIDDLE_POSITION_STYLE,
} from "@src/modules/shared/layouts/blocks";
import {
  type AgentSelection,
  DispatchCategoryPalette,
} from "@src/scaffold/GlobalSpotlight/palettes/DispatchCategoryPalette";
import { DispatchCategoryDropdown } from "@src/scaffold/GlobalSpotlight/palettes/DispatchCategoryPalette/DispatchCategoryDropdown";
import { PresenceMenuButton } from "@src/scaffold/NavigationSidebar/blocks/SidebarBottomBar";
import type { CreatorRepoChromePosition } from "@src/store/session";

import { EditorArea, SessionInfoLine } from "../../components";
import RepoChromeRow from "./RepoChromeRow";
import ScreenPickerModal from "./ScreenPickerModal";
import SessionCreatorAgentHero from "./SessionCreatorAgentHero";
import SessionCreatorOrgMembersPanel from "./SessionCreatorOrgMembersPanel";
import WorkItemAttachmentControl from "./WorkItemAttachmentControl";
import { isRepoChromeAboveComposer } from "./repoChromeLayout";
import type { SessionCreatorAgentHeroContent } from "./resolveSessionCreatorAgentHero";
import type { SessionCreatorChatPanelHeaderLayout } from "./types";

interface CategoryPickerProps {
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  currentAgentDefinitionId?: string;
  currentAgentOrgId?: string;
  currentCategory: DispatchCategory;
  currentCliAgentType?: CliAgentType;
  includeHumanSession: boolean;
  modelPickerStyle: string;
  onClose: () => void;
  onSelect: (selection: AgentSelection) => void;
}

interface CliVersionAlert {
  cliDisplayName: string | undefined;
  installedVersion: string | undefined;
  latestVersion: string | undefined;
  refreshing: boolean;
  onMuteUntilNextVersion: () => void;
  onRefresh: () => void;
  onClose: () => void;
}

interface SessionCreatorChatPanelViewProps {
  agentHeroRef: React.RefObject<HTMLButtonElement | null>;
  browserElementScrollNav: ScrollNavState;
  canLaunch: boolean;
  centerFullScreenContent: boolean;
  className: string;
  cliLaunchModeSwitch: React.ReactNode;
  cliVersionAlert?: CliVersionAlert;
  compactHeaderIcon: React.ReactNode;
  composerHeaderContent?: React.ReactNode;
  composerInputRef: React.RefObject<ComposerInputRef | null>;
  editorAreaProps: React.ComponentProps<typeof EditorArea>;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  footerSlot?: React.ReactNode;
  headerLayout: SessionCreatorChatPanelHeaderLayout;
  heroFooterSlot?: React.ReactNode;
  heroContent: SessionCreatorAgentHeroContent;
  heroIcon: React.ReactNode;
  hidePresenceButton: boolean;
  hideRepoLine: boolean;
  hideWorkItemAttachmentControl: boolean;
  innerClassName?: string;
  isCategorySelectorOpen: boolean;
  isCliTuiMode: boolean;
  isFullScreenVariant: boolean;
  isLaunchpadLayout: boolean;
  isLoading: boolean;
  hideSessionSetupControls: boolean;
  isOrgMembersPanelOpen: boolean;
  isWingmanMode: boolean;
  leadingActionSlot?: React.ReactNode;
  /**
   * Runner list rendered in place of the launchpad's agent hero + action
   * cards while multi-runner mode is on. Present only for that mode.
   */
  multiRunnerContent?: React.ReactNode;
  onAttachedWorkItemContextChange: React.Dispatch<
    React.SetStateAction<SessionLaunchWorkItemContext | null>
  >;
  onCategoryPickerOpen: () => void;
  onCreateWorkItem?: () => void;
  onFileUpload: React.ChangeEventHandler<HTMLInputElement>;
  onLaunch: () => void;
  onPinnedActionsVisibleChange: (visible: boolean) => void;
  onRepoChromePositionChange: (position: CreatorRepoChromePosition) => void;
  onShareScreen: () => Promise<unknown>;
  onToggleOrgMembers: () => void;
  orgMembersPanelProps?: React.ComponentProps<
    typeof SessionCreatorOrgMembersPanel
  >;
  pinnedActionsContent?: React.ReactNode;
  pinnedActionsVisible: boolean;
  repoChromePosition: CreatorRepoChromePosition;
  categoryPickerProps: CategoryPickerProps;
  screenPickerProps?: React.ComponentProps<typeof ScreenPickerModal>;
  sessionInfoProps: React.ComponentProps<typeof SessionInfoLine>;
  showMissingGitAlert: boolean;
  workItemContext: SessionLaunchWorkItemContext | null;
}

const SessionCreatorChatPanelView: React.FC<
  SessionCreatorChatPanelViewProps
> = ({
  agentHeroRef,
  browserElementScrollNav,
  canLaunch,
  centerFullScreenContent,
  className,
  cliLaunchModeSwitch,
  cliVersionAlert,
  compactHeaderIcon,
  composerHeaderContent,
  composerInputRef,
  editorAreaProps,
  fileInputRef,
  footerSlot,
  headerLayout,
  heroFooterSlot,
  heroContent,
  heroIcon,
  hidePresenceButton,
  hideRepoLine,
  hideWorkItemAttachmentControl,
  innerClassName,
  isCategorySelectorOpen,
  isCliTuiMode,
  isFullScreenVariant,
  isLaunchpadLayout,
  isLoading,
  hideSessionSetupControls,
  isOrgMembersPanelOpen,
  isWingmanMode,
  leadingActionSlot,
  multiRunnerContent,
  onAttachedWorkItemContextChange,
  onCategoryPickerOpen,
  onCreateWorkItem,
  onFileUpload,
  onLaunch,
  onPinnedActionsVisibleChange,
  onRepoChromePositionChange,
  onShareScreen,
  onToggleOrgMembers,
  orgMembersPanelProps,
  pinnedActionsContent,
  pinnedActionsVisible,
  repoChromePosition,
  categoryPickerProps,
  screenPickerProps,
  sessionInfoProps,
  showMissingGitAlert,
  workItemContext,
}) => {
  const { t } = useTranslation(["sessions", "common"]);
  const handlePinnedActionsContextMenu = usePinnedActionsVisibilityContextMenu({
    visible: pinnedActionsVisible,
    onVisibleChange: onPinnedActionsVisibleChange,
  });
  const [isLaunchpadWorkItemPickerOpen, setIsLaunchpadWorkItemPickerOpen] =
    useState(false);
  const [workItemPickerPortalTarget, setWorkItemPickerPortalTarget] =
    useState<HTMLDivElement | null>(null);
  const sessionInfoLine = (
    <SessionInfoLine
      {...sessionInfoProps}
      dropdownDirection={
        isLaunchpadLayout ? "up" : sessionInfoProps.dropdownDirection
      }
    />
  );
  const repoPills = (
    <div className="flex w-full justify-center">
      <div
        className={`flex w-full flex-wrap items-center justify-start gap-0.5 ${DETAIL_PANEL_TOKENS.contentMaxWidth}`}
      >
        {sessionInfoLine}
      </div>
    </div>
  );
  const repoChromeAboveComposer = isRepoChromeAboveComposer(repoChromePosition);
  const hasRepoChromeMenu = !hideRepoLine && headerLayout !== "compact";
  const showPinnedActionPills = !hasRepoChromeMenu || pinnedActionsVisible;
  const repoPillsRow =
    !isLaunchpadWorkItemPickerOpen && hasRepoChromeMenu ? (
      <RepoChromeRow
        pinnedActionsVisible={pinnedActionsVisible}
        position={repoChromePosition}
        onPinnedActionsVisibleChange={onPinnedActionsVisibleChange}
        onPositionChange={onRepoChromePositionChange}
      >
        {repoPills}
      </RepoChromeRow>
    ) : null;
  const compactHeader = headerLayout === "compact" && (
    <div className="session-creator-chat-panel-compact-header flex w-full items-center justify-between gap-2 bg-bg-2 px-1 pb-2 pt-1">
      <SelectorPill
        ref={agentHeroRef}
        icon={compactHeaderIcon}
        label={heroContent.name}
        active={isCategorySelectorOpen}
        danger={heroContent.danger}
        size="md"
        tooltip={t("creator.switchAgent")}
        tooltipPosition="top"
        onClick={onCategoryPickerOpen}
        ariaLabel={heroContent.name}
        appearance="bare"
      />
      {!isLaunchpadWorkItemPickerOpen && (
        <div className="ml-auto flex min-w-0 flex-1 flex-wrap items-center justify-end gap-0.5">
          {sessionInfoLine}
        </div>
      )}
    </div>
  );
  const tuiComposerHeader = composerHeaderContent ? (
    <div className="session-creator-chat-panel-fullscreen-header-row px-1 pb-3 pt-2">
      {composerHeaderContent}
    </div>
  ) : null;
  const editorHeaderContent =
    composerHeaderContent ?? editorAreaProps.headerContent;
  const browserElementRowContent = useMemo(
    () =>
      browserElementScrollNav.showAddToConversation ? (
        <CollapsedInlineRow sections={[]} scrollNav={browserElementScrollNav} />
      ) : null,
    [browserElementScrollNav]
  );
  const showWorkItemAttachmentControl =
    !hideWorkItemAttachmentControl &&
    (!isLaunchpadLayout || Boolean(multiRunnerContent));
  const hasSetupControlsAfterCliSwitch =
    showWorkItemAttachmentControl ||
    Boolean(orgMembersPanelProps) ||
    Boolean(pinnedActionsContent);
  const sessionSetupActions = !hideSessionSetupControls ? (
    <div
      className={`mx-auto flex w-full items-center ${DETAIL_PANEL_TOKENS.contentMaxWidth}`}
      onContextMenu={handlePinnedActionsContextMenu}
    >
      <PinnedActionsBar
        composerInputRef={composerInputRef}
        manageButtonPlacement="before-actions"
        managePanelAlign="left"
        showBeforeActionsSeparator={Boolean(cliLaunchModeSwitch)}
        showPinnedActions={showPinnedActionPills}
        trailingContent={pinnedActionsContent}
        leadingContent={
          <>
            {browserElementRowContent}
            {leadingActionSlot}
            {cliLaunchModeSwitch}
            {cliLaunchModeSwitch && hasSetupControlsAfterCliSwitch && (
              <div aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border-2" />
            )}
            {showWorkItemAttachmentControl && (
              <WorkItemAttachmentControl
                composerInputRef={composerInputRef}
                currentWorkItemContext={workItemContext}
                onCreateWorkItem={onCreateWorkItem}
                onWorkItemContextChange={onAttachedWorkItemContextChange}
                repoId={sessionInfoProps.repoId}
                repoPath={sessionInfoProps.repoPath}
                mode="add"
              />
            )}
            {orgMembersPanelProps && (
              <Button
                variant="secondary"
                appearance="outline"
                size="small"
                shape="round"
                icon={<Network size={14} strokeWidth={1.75} />}
                title={t("creator.orgMembers.configButton")}
                aria-label={t("creator.orgMembers.configButton")}
                aria-expanded={isOrgMembersPanelOpen}
                aria-controls="session-creator-org-members-panel"
                onClick={onToggleOrgMembers}
                className={`shrink-0 ${pillControlStateClass(isOrgMembersPanelOpen)}`}
                data-testid="session-creator-org-members-toggle"
              >
                {t("creator.orgMembers.configButton")}
              </Button>
            )}
          </>
        }
      />
    </div>
  ) : null;
  const cliVersionWarning =
    !hideSessionSetupControls && cliVersionAlert ? (
      <div className={`mx-auto w-full ${DETAIL_PANEL_TOKENS.contentMaxWidth}`}>
        <InlineAlert
          type="warning"
          icon={<CircleArrowUp size={14} strokeWidth={1.8} />}
          onClose={cliVersionAlert.onClose}
          closeAriaLabel={t("common:actions.close")}
          action={
            <div className="flex items-center gap-px">
              <Button
                variant="tertiary"
                size="small"
                icon={<BellOff size={14} strokeWidth={1.8} />}
                iconOnly
                disabled={!cliVersionAlert.latestVersion}
                title={t("creator.cliVersionOutdated.muteUntilNextVersion")}
                aria-label={t(
                  "creator.cliVersionOutdated.muteUntilNextVersion"
                )}
                data-testid="session-creator-cli-version-mute"
                onClick={cliVersionAlert.onMuteUntilNextVersion}
              />
              <Button
                variant="tertiary"
                size="small"
                icon={<RefreshCw size={14} strokeWidth={1.8} />}
                iconOnly
                loading={cliVersionAlert.refreshing}
                loadingSpinIcon
                disabled={cliVersionAlert.refreshing}
                title={t("creator.cliVersionOutdated.refresh", {
                  cli: cliVersionAlert.cliDisplayName,
                })}
                aria-label={t("creator.cliVersionOutdated.refresh", {
                  cli: cliVersionAlert.cliDisplayName,
                })}
                data-testid="session-creator-cli-version-refresh"
                onClick={cliVersionAlert.onRefresh}
              />
            </div>
          }
          title={t("creator.cliVersionOutdated.title", {
            cli: cliVersionAlert.cliDisplayName,
            installed:
              cliVersionAlert.installedVersion ??
              t("creator.cliVersionOutdated.unknownVersion"),
            latest:
              cliVersionAlert.latestVersion ??
              t("creator.cliVersionOutdated.unknownVersion"),
          })}
        />
      </div>
    ) : null;
  const agentHero = headerLayout !== "compact" && (
    <SessionCreatorAgentHero
      ref={agentHeroRef}
      name={heroContent.name}
      description={heroContent.description}
      avatarIcon={heroIcon}
      question={isLaunchpadLayout ? t("creator.launchpadQuestion") : undefined}
      questionSuffix={
        isLaunchpadLayout
          ? t("creator.launchpadQuestionSuffix", { defaultValue: "" })
          : undefined
      }
      active={isCategorySelectorOpen}
      danger={heroContent.danger}
      onClick={onCategoryPickerOpen}
    />
  );
  const launchpadSuggestionContent = hideWorkItemAttachmentControl ? (
    heroFooterSlot
  ) : (
    <LaunchpadActionGrid
      className="mx-auto w-full"
      layoutActionCount={Children.count(heroFooterSlot) + 1}
      presentation="card"
      collapsible={!isLaunchpadWorkItemPickerOpen}
      controlAlignment="center"
      collapseLabel={t("common:actions.collapse")}
      expandLabel={t("common:actions.expand")}
    >
      <WorkItemAttachmentControl
        composerInputRef={composerInputRef}
        currentWorkItemContext={workItemContext}
        onWorkItemContextChange={onAttachedWorkItemContextChange}
        onPickerOpenChange={setIsLaunchpadWorkItemPickerOpen}
        pickerPortalTarget={workItemPickerPortalTarget}
        repoId={sessionInfoProps.repoId}
        repoPath={sessionInfoProps.repoPath}
        mode="solve"
        presentation="card"
      />
      {!isLaunchpadWorkItemPickerOpen && heroFooterSlot}
    </LaunchpadActionGrid>
  );
  const launchpadMiddleContent = isLaunchpadLayout ? (
    <div
      className="session-creator-chat-panel-launchpad-middle absolute inset-x-0 flex -translate-y-1/2 flex-col items-center gap-4"
      style={CREATOR_MIDDLE_POSITION_STYLE}
    >
      {/* Multi-runner owns the whole middle slot: with N runners listed below
          it, a single-harness hero pill would name one of them and imply the
          others do not exist. */}
      {multiRunnerContent ? (
        <div
          className={`session-creator-chat-panel-launchpad-runners mx-auto w-full ${DETAIL_PANEL_TOKENS.contentMaxWidth}`}
        >
          {multiRunnerContent}
        </div>
      ) : (
        <>
          {agentHero}
          {launchpadSuggestionContent && (
            <div
              className={`session-creator-chat-panel-launchpad-suggestions w-full ${
                isLaunchpadWorkItemPickerOpen ? "hidden" : ""
              }`}
            >
              {launchpadSuggestionContent}
            </div>
          )}
        </>
      )}
    </div>
  ) : null;
  const composerDockClassName = isLaunchpadLayout
    ? `relative z-10 mt-auto flex w-full shrink-0 flex-col gap-3 ${
        isLaunchpadWorkItemPickerOpen ? "min-h-0 flex-1 justify-end" : ""
      }`
    : "contents";
  const composerGroupClassName = `session-creator-chat-panel-fullscreen-composer-group mx-auto w-full ${DETAIL_PANEL_TOKENS.contentMaxWidth} ${
    isLaunchpadWorkItemPickerOpen
      ? "flex min-h-0 flex-1 flex-col justify-end"
      : ""
  }`;
  const composerFrameClassName = `session-creator-chat-panel-fullscreen-composer w-full ${
    headerLayout === "compact"
      ? "session-creator-chat-panel-fullscreen-composer-compact"
      : ""
  }`;
  const composerBody = isCliTuiMode ? (
    <div className="rounded-xl bg-chat-container p-3">
      <button
        type="button"
        onClick={onLaunch}
        disabled={!canLaunch || isLoading}
        className="flex w-full items-center justify-center rounded-full bg-primary-6 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-primary-7 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {t("creator.start")}
      </button>
    </div>
  ) : (
    <EditorArea
      {...editorAreaProps}
      headerContent={editorHeaderContent}
      dropdownDirection={
        isLaunchpadLayout ? "up" : editorAreaProps.dropdownDirection
      }
    />
  );

  return (
    <div
      className={`session-creator-chat-panel-wrapper ${
        isLaunchpadLayout ? "h-full" : ""
      } ${
        isLaunchpadWorkItemPickerOpen
          ? "session-creator-chat-panel-work-item-picker-open"
          : ""
      } ${className}`}
      data-testid="session-creator-chat-panel"
    >
      <div
        className={`session-creator-chat-panel-content flex min-h-0 flex-1 ${COMPOSER_HORIZONTAL_GUTTER_CLASS} ${DETAIL_PANEL_TOKENS.headerWidth} ${
          isLaunchpadLayout
            ? `session-creator-chat-panel-launchpad-content flex-col ${CREATOR_BOTTOM_DOCK_PADDING_CLASS}`
            : `items-center justify-center ${
                innerClassName ??
                (isFullScreenVariant
                  ? centerFullScreenContent
                    ? "pb-[10vh]"
                    : "pb-[18vh]"
                  : "pb-[4vh]")
              }`
        }`}
      >
        <div
          className={`flex w-full flex-col items-stretch gap-3 ${
            isLaunchpadLayout
              ? "session-creator-chat-panel-launchpad-stack relative min-h-0 flex-1"
              : ""
          }`}
        >
          {launchpadMiddleContent}
          {!isLaunchpadLayout && agentHero}
          <div className={composerDockClassName}>
            {!isCliTuiMode && isWingmanMode && (
              <button
                type="button"
                className="flex items-center gap-1.5 rounded-full border border-dashed border-border-2 px-3 py-1.5 text-[12px] text-text-3 transition-colors hover:border-primary-4 hover:text-primary-6"
                onClick={() => {
                  void onShareScreen();
                }}
              >
                <Airplay size={13} strokeWidth={1.75} />
                {t("chat.shareScreen")}
              </button>
            )}
            {isLaunchpadLayout && (
              <>
                {!isLaunchpadWorkItemPickerOpen && sessionSetupActions}
                {cliVersionWarning}
              </>
            )}
            <div
              className={composerGroupClassName}
              onContextMenu={handlePinnedActionsContextMenu}
            >
              {isLaunchpadLayout && (
                <div
                  ref={setWorkItemPickerPortalTarget}
                  className={
                    isLaunchpadWorkItemPickerOpen
                      ? "session-creator-chat-panel-launchpad-suggestions session-creator-chat-panel-work-item-picker-chrome flex min-h-0 w-full flex-1 flex-col border border-border-2"
                      : "hidden"
                  }
                  data-testid="session-creator-work-item-picker-chrome"
                />
              )}
              <div className={composerFrameClassName}>
                {compactHeader}
                {isCliTuiMode && tuiComposerHeader}
                {/* Keep this slot mounted so moving only the chrome cannot
                    shift or remount the composer input below it. */}
                <div className="contents">
                  {repoChromeAboveComposer && repoPillsRow}
                </div>
                {composerBody}
              </div>
              {/* The bottom slot sits outside the complete composer frame;
                  its existing overlap, radii, and z-order stay in CSS. */}
              <div className="contents">
                {!repoChromeAboveComposer && repoPillsRow}
              </div>
            </div>
          </div>

          {!hideSessionSetupControls && showMissingGitAlert && (
            <div
              className={`mx-auto w-full ${DETAIL_PANEL_TOKENS.contentMaxWidth}`}
            >
              <InlineAlert type="warning" title={t("creator.missingGit.title")}>
                {t("creator.missingGit.body")}
              </InlineAlert>
            </div>
          )}

          {!isLaunchpadLayout && (
            <>
              {sessionSetupActions}
              {cliVersionWarning}
            </>
          )}

          {!hideSessionSetupControls &&
            orgMembersPanelProps &&
            isOrgMembersPanelOpen && (
              <div id="session-creator-org-members-panel">
                <SessionCreatorOrgMembersPanel {...orgMembersPanelProps} />
              </div>
            )}

          {!hideSessionSetupControls && !hidePresenceButton && (
            <div className="flex w-full items-center justify-center gap-2 pt-1">
              <PresenceMenuButton
                variant="detailed"
                dropdownPosition={
                  isLaunchpadLayout ? "top-start" : "bottom-start"
                }
              />
            </div>
          )}
          {!hideSessionSetupControls && footerSlot}
        </div>
      </div>

      {!hideSessionSetupControls && (
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          data-testid="chat-file-upload-input"
          onChange={onFileUpload}
          accept="*/*"
        />
      )}

      {categoryPickerProps.modelPickerStyle === "dropdown" ? (
        <DispatchCategoryDropdown
          includeHumanSession={categoryPickerProps.includeHumanSession}
          isOpen={isCategorySelectorOpen}
          onClose={categoryPickerProps.onClose}
          onSelect={categoryPickerProps.onSelect}
          currentCategory={categoryPickerProps.currentCategory}
          currentAgentDefinitionId={
            categoryPickerProps.currentAgentDefinitionId
          }
          currentAgentOrgId={categoryPickerProps.currentAgentOrgId}
          currentCliAgentType={categoryPickerProps.currentCliAgentType}
          anchorRef={categoryPickerProps.anchorRef}
        />
      ) : (
        <DispatchCategoryPalette
          includeHumanSession={categoryPickerProps.includeHumanSession}
          isOpen={isCategorySelectorOpen}
          onClose={categoryPickerProps.onClose}
          onSelect={categoryPickerProps.onSelect}
          currentCategory={categoryPickerProps.currentCategory}
          currentAgentDefinitionId={
            categoryPickerProps.currentAgentDefinitionId
          }
          currentAgentOrgId={categoryPickerProps.currentAgentOrgId}
          currentCliAgentType={categoryPickerProps.currentCliAgentType}
        />
      )}

      {screenPickerProps && <ScreenPickerModal {...screenPickerProps} />}
    </div>
  );
};

SessionCreatorChatPanelView.displayName = "SessionCreatorChatPanelView";

export default SessionCreatorChatPanelView;
