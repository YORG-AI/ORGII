import { Airplay, Network } from "lucide-react";
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { DispatchCategory } from "@src/api/tauri/session";
import type { CliAgentType } from "@src/api/types/keys";
import Button from "@src/components/Button";
import type { ComposerInputRef } from "@src/components/ComposerInput";
import InlineAlert from "@src/components/InlineAlert";
import SelectorPill from "@src/components/SelectorPill";
import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";
import type { ScrollNavState } from "@src/engines/ChatPanel/ChatHistory";
import CollapsedInlineRow from "@src/engines/ChatPanel/InputArea/components/CollapsedInlineRow";
import PinnedActionsBar from "@src/engines/ChatPanel/InputArea/components/PinnedActionsBar";
import type { SessionLaunchWorkItemContext } from "@src/engines/SessionCore/hooks/session/useSessionCreator/useSessionLaunch/types";
import {
  type AgentSelection,
  DispatchCategoryPalette,
} from "@src/scaffold/GlobalSpotlight/palettes/DispatchCategoryPalette";
import { DispatchCategoryDropdown } from "@src/scaffold/GlobalSpotlight/palettes/DispatchCategoryPalette/DispatchCategoryDropdown";
import { PresenceMenuButton } from "@src/scaffold/NavigationSidebar/blocks/SidebarBottomBar";

import { EditorArea, SessionInfoLine } from "../../components";
import ScreenPickerModal from "./ScreenPickerModal";
import SessionCreatorAgentHero from "./SessionCreatorAgentHero";
import SessionCreatorOrgMembersPanel from "./SessionCreatorOrgMembersPanel";
import WorkItemAttachmentControl from "./WorkItemAttachmentControl";
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
  heroContent: SessionCreatorAgentHeroContent;
  heroIcon: React.ReactNode;
  hidePresenceButton: boolean;
  hideRepoLine: boolean;
  innerClassName?: string;
  isCategorySelectorOpen: boolean;
  isCliTuiMode: boolean;
  isFullScreenVariant: boolean;
  isLoading: boolean;
  hideSessionSetupControls: boolean;
  isOrgMembersPanelOpen: boolean;
  isWingmanMode: boolean;
  leadingActionSlot?: React.ReactNode;
  onAttachedWorkItemContextChange: React.Dispatch<
    React.SetStateAction<SessionLaunchWorkItemContext | null>
  >;
  onCategoryPickerOpen: () => void;
  onFileUpload: React.ChangeEventHandler<HTMLInputElement>;
  onLaunch: () => void;
  onShareScreen: () => Promise<unknown>;
  onToggleOrgMembers: () => void;
  orgMembersPanelProps?: React.ComponentProps<
    typeof SessionCreatorOrgMembersPanel
  >;
  categoryPickerProps: CategoryPickerProps;
  screenPickerProps?: React.ComponentProps<typeof ScreenPickerModal>;
  sessionInfoProps: React.ComponentProps<typeof SessionInfoLine>;
  showMissingGitAlert: boolean;
  workItemContext: SessionLaunchWorkItemContext | null;
  workItemPanelHostRef: React.RefObject<HTMLDivElement | null>;
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
  heroContent,
  heroIcon,
  hidePresenceButton,
  hideRepoLine,
  innerClassName,
  isCategorySelectorOpen,
  isCliTuiMode,
  isFullScreenVariant,
  isLoading,
  hideSessionSetupControls,
  isOrgMembersPanelOpen,
  isWingmanMode,
  leadingActionSlot,
  onAttachedWorkItemContextChange,
  onCategoryPickerOpen,
  onFileUpload,
  onLaunch,
  onShareScreen,
  onToggleOrgMembers,
  orgMembersPanelProps,
  categoryPickerProps,
  screenPickerProps,
  sessionInfoProps,
  showMissingGitAlert,
  workItemContext,
  workItemPanelHostRef,
}) => {
  const { t } = useTranslation("sessions");
  const sessionInfoLine = <SessionInfoLine {...sessionInfoProps} />;
  const repoPills = (
    <div className="flex w-full justify-center">
      <div
        className={`flex w-full flex-wrap items-center justify-start gap-0.5 ${DETAIL_PANEL_TOKENS.contentMaxWidth}`}
      >
        {sessionInfoLine}
      </div>
    </div>
  );
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
        variant="ghost"
      />
      <div className="ml-auto flex min-w-0 flex-1 flex-wrap items-center justify-end gap-0.5">
        {sessionInfoLine}
      </div>
    </div>
  );
  const composerHeader = composerHeaderContent ? (
    <div className="session-creator-chat-panel-fullscreen-header-row px-1 pb-3 pt-2">
      {composerHeaderContent}
    </div>
  ) : null;
  const browserElementRowContent = useMemo(
    () =>
      browserElementScrollNav.showAddToConversation ? (
        <CollapsedInlineRow sections={[]} scrollNav={browserElementScrollNav} />
      ) : null,
    [browserElementScrollNav]
  );

  return (
    <div
      className={`session-creator-chat-panel-wrapper ${className}`}
      data-testid="session-creator-chat-panel"
    >
      <div
        className={`session-creator-chat-panel-content flex min-h-0 flex-1 items-center justify-center px-4 ${DETAIL_PANEL_TOKENS.headerWidth} ${
          innerClassName ??
          (isFullScreenVariant
            ? centerFullScreenContent
              ? "pb-[10vh]"
              : "pb-[18vh]"
            : "pb-[4vh]")
        }`}
      >
        <div className="flex w-full flex-col items-stretch gap-3">
          {isCliTuiMode ? (
            <>
              {headerLayout !== "compact" && (
                <SessionCreatorAgentHero
                  ref={agentHeroRef}
                  name={heroContent.name}
                  description={heroContent.description}
                  avatarIcon={heroIcon}
                  active={isCategorySelectorOpen}
                  danger={heroContent.danger}
                  onClick={onCategoryPickerOpen}
                />
              )}
              <div
                className={`session-creator-chat-panel-fullscreen-composer w-full ${
                  headerLayout === "compact"
                    ? "session-creator-chat-panel-fullscreen-composer-compact"
                    : ""
                }`}
              >
                {compactHeader}
                {composerHeader}
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
                {!hideRepoLine && headerLayout !== "compact" && (
                  <div className="session-creator-chat-panel-fullscreen-repo-row px-1 pb-2 pt-3">
                    {repoPills}
                  </div>
                )}
              </div>
            </>
          ) : (
            <>
              {headerLayout !== "compact" && (
                <SessionCreatorAgentHero
                  ref={agentHeroRef}
                  name={heroContent.name}
                  description={heroContent.description}
                  avatarIcon={heroIcon}
                  active={isCategorySelectorOpen}
                  danger={heroContent.danger}
                  onClick={onCategoryPickerOpen}
                />
              )}
              {isWingmanMode && (
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
              <div
                className={`session-creator-chat-panel-fullscreen-composer w-full ${
                  headerLayout === "compact"
                    ? "session-creator-chat-panel-fullscreen-composer-compact"
                    : ""
                }`}
              >
                {compactHeader}
                {composerHeader}
                <EditorArea {...editorAreaProps} />
                {!hideRepoLine && headerLayout !== "compact" && (
                  <div className="session-creator-chat-panel-fullscreen-repo-row px-1 pb-2 pt-3">
                    {repoPills}
                  </div>
                )}
              </div>
            </>
          )}

          {!hideSessionSetupControls && showMissingGitAlert && (
            <div
              className={`mx-auto w-full ${DETAIL_PANEL_TOKENS.contentMaxWidth}`}
            >
              <InlineAlert type="warning" title={t("creator.missingGit.title")}>
                {t("creator.missingGit.body")}
              </InlineAlert>
            </div>
          )}

          {!hideSessionSetupControls && (
            <div
              className={`mx-auto flex w-full items-center ${DETAIL_PANEL_TOKENS.contentMaxWidth}`}
            >
              <PinnedActionsBar
                composerInputRef={composerInputRef}
                manageButtonPlacement="after-leading"
                managePanelAlign="left"
                leadingContent={
                  <>
                    {browserElementRowContent}
                    {leadingActionSlot}
                    {cliLaunchModeSwitch}
                    {cliLaunchModeSwitch && (
                      <div
                        aria-hidden
                        className="mx-1 h-4 w-px shrink-0 bg-border-2"
                      />
                    )}
                    <WorkItemAttachmentControl
                      currentWorkItemContext={workItemContext}
                      panelHostRef={workItemPanelHostRef}
                      repoPath={sessionInfoProps.repoPath}
                      onWorkItemContextChange={onAttachedWorkItemContextChange}
                    />
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
                        className={
                          isOrgMembersPanelOpen
                            ? "shrink-0 !bg-fill-1 !text-primary-6"
                            : "shrink-0"
                        }
                        data-testid="session-creator-org-members-toggle"
                      >
                        {t("creator.orgMembers.configButton")}
                      </Button>
                    )}
                  </>
                }
              />
            </div>
          )}

          {!hideSessionSetupControls && cliVersionAlert && (
            <div
              className={`mx-auto w-full ${DETAIL_PANEL_TOKENS.contentMaxWidth}`}
            >
              <InlineAlert
                type="warning"
                onClose={cliVersionAlert.onClose}
                closeAriaLabel={t("common:actions.close")}
                title={t("creator.cliVersionOutdated.title", {
                  cli: cliVersionAlert.cliDisplayName,
                })}
              >
                {t("creator.cliVersionOutdated.body", {
                  installed:
                    cliVersionAlert.installedVersion ??
                    t("creator.cliVersionOutdated.unknownVersion"),
                  latest:
                    cliVersionAlert.latestVersion ??
                    t("creator.cliVersionOutdated.unknownVersion"),
                })}
              </InlineAlert>
            </div>
          )}

          {!hideSessionSetupControls && (
            <div
              ref={workItemPanelHostRef}
              className={`mx-auto w-full ${DETAIL_PANEL_TOKENS.contentMaxWidth}`}
            />
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
                dropdownPosition="bottom-start"
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
