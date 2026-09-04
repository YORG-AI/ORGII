import { useAtom, useAtomValue } from "jotai";
import React, { memo, useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { ComposerInputRef } from "@src/components/ComposerInput";
import ComposerShell from "@src/components/ComposerShell";
import { useInputArea } from "@src/engines/ChatPanel/hooks/useInputArea";
import type {
  CustomMentionOption,
  SubmitOverrideInput,
} from "@src/engines/ChatPanel/hooks/useInputArea/types";
import { useSessionDiscovery } from "@src/engines/SessionCore";
import { useSessionId } from "@src/engines/SessionCore/hooks/session";
import { useSessionCommentsContext } from "@src/features/Org2Cloud/SessionComments/SessionCommentsContext";
import { ConversationModePill } from "@src/features/Org2Cloud/SessionConversation/ConversationModePill";
import { buildTeamChatMentionOptions } from "@src/features/Org2Cloud/SessionConversation/teamChatMentions";
import {
  useConversationComposerMode,
  useConversationSubmitOverride,
} from "@src/features/Org2Cloud/SessionConversation/useConversationComposer";
import { voiceInputEnabledAtom } from "@src/store/platform/voiceInputAtom";
import { pinnedActionsVisibleAtom } from "@src/store/session";
import type { SlashItemCategory } from "@src/types/extensions";
import { isCursorIdeSession } from "@src/util/session/sessionDispatch";

import EditModeHeader from "./components/EditModeHeader";
import {
  EditImagePreviews,
  InputAreaTopRows,
  QuietEditStatus,
  getComposerShellClassName,
  getComposerShellVariant,
} from "./components/InputAreaChrome";
import { InputAreaPortals } from "./components/InputAreaPortals";
import {
  EditComposerBar,
  NormalComposerContent,
} from "./components/InputComposerBars";
import ModePill from "./components/ModePill";
import ModelPill from "./components/ModelPill";
import { usePinnedActionsVisibilityContextMenu } from "./components/PinnedActionsBar/usePinnedActionsVisibilityContextMenu";
import SessionReadOnlyBar from "./components/SessionReadOnlyBar";
import { useContainerDrag } from "./hooks/useContainerDrag";
import { useEditMode } from "./hooks/useEditMode";
import { useInputAreaMenus } from "./hooks/useInputAreaMenus";
import { useInputAreaVoice } from "./hooks/useInputAreaVoice";
import { useStopOnDoubleEscape } from "./hooks/useStopOnDoubleEscape";
import {
  type InputAreaPresentation,
  isContextualInputAreaPresentation,
} from "./inputAreaPresentation";
import { openedTabMentionOptionsAtom } from "./openedTabMentionOptionsAtom";

interface InputAreaProps {
  placeholder?: string;
  isEditMode?: boolean;
  initialContent?: string;
  onEditSubmit?: (text: string, imageDataUrls?: string[]) => void;
  onEditSendNow?: (text: string, imageDataUrls?: string[]) => void;
  onEditCancel?: () => void;
  editLabel?: string;
  editHeaderActions?: boolean;
  showEditHeader?: boolean;
  quietEditSurface?: boolean;
  editImages?: string[];
  onRemoveEditImage?: (index: number) => void;
  surfaceBg?: boolean;
  omitChatHeader?: boolean;
  chatPanelPosition?: "left" | "right";
  sessionId?: string;
  onSubmitOverride?: (input: SubmitOverrideInput) => Promise<boolean>;
  customMentionOptions?: ReadonlyArray<CustomMentionOption>;
  topRowPills?: React.ReactNode;
  topRowTrailingContent?: React.ReactNode;
  statusBanners?: React.ReactNode;
  composerShellRef?: React.Ref<HTMLDivElement>;
  /**
   * Mirror of the live editor handle for surfaces that insert into this
   * composer from OUTSIDE its own rect — the channel panel drops a session
   * anywhere over its transcript and turns it into a pill here.
   */
  composerInputRef?: React.MutableRefObject<ComposerInputRef | null>;
  /**
   * False to refuse dragged tab/session reference pills on this composer.
   * Used by the cloud channel composer, which has no message plane to post
   * them to, so accepting a pill would be a lie.
   */
  acceptDraggedPills?: boolean;
  disableStopWhenEmpty?: boolean;
  submitDisabled?: boolean;
  sessionScope?: "active" | "none";
  /** Hide controls that only affect agent execution (model, mode, polish, voice). */
  showAgentControls?: boolean;
  /** Enable pasted, uploaded, and externally dropped file attachments. */
  allowFileAttachments?: boolean;
  /** Enable agent-only submit interceptors such as /compact and MCP tools. */
  enableAgentInterceptors?: boolean;
  /** Focus the shared composer editor when this InputArea mounts. */
  autoFocus?: boolean;
  /** Limit the slash menu to the supplied item categories. */
  slashItemCategories?: ReadonlyArray<SlashItemCategory>;
  /** Contextual composers used by element-selection surfaces. */
  presentation?: InputAreaPresentation;
}

/**
 * Gateway: resolves the session ID, then either renders the read-only bar
 * (cursor IDE) or delegates to `InputAreaInteractive` for all other sessions.
 * Keeping the split here means `InputAreaInteractive` never mounts its heavy
 * hooks for read-only sessions.
 */
const InputArea: React.FC<InputAreaProps> = memo((props) => {
  const { sessionId: propSessionId, isEditMode = false } = props;

  useSessionDiscovery({ autoLoad: true });
  const { sessionId } = useSessionId({ propSessionId });
  const isCursorIde = sessionId ? isCursorIdeSession(sessionId) : false;

  if (isCursorIde && !isEditMode && sessionId) {
    return <SessionReadOnlyBar />;
  }

  return <InputAreaInteractive {...props} />;
});

InputArea.displayName = "InputArea";

const InputAreaInteractive: React.FC<InputAreaProps> = memo(
  ({
    placeholder,
    isEditMode = false,
    initialContent,
    onEditSubmit,
    onEditSendNow,
    onEditCancel,
    editLabel,
    editHeaderActions = true,
    showEditHeader = true,
    quietEditSurface = false,
    editImages,
    onRemoveEditImage,
    surfaceBg = false,
    omitChatHeader = false,
    sessionId: propSessionId,
    onSubmitOverride,
    customMentionOptions,
    topRowPills,
    topRowTrailingContent,
    statusBanners,
    composerShellRef,
    composerInputRef: externalComposerInputRef,
    acceptDraggedPills = true,
    disableStopWhenEmpty = false,
    submitDisabled = false,
    sessionScope = "active",
    showAgentControls = true,
    allowFileAttachments = true,
    enableAgentInterceptors = true,
    autoFocus = false,
    slashItemCategories,
    presentation = "default",
  }) => {
    const { t } = useTranslation("sessions");

    const { sessionId } = useSessionId({ propSessionId });
    const isCursorIde = sessionId ? isCursorIdeSession(sessionId) : false;
    const conversationSubmitOverride = useConversationSubmitOverride(
      sessionId ?? null,
      onSubmitOverride
    );
    const [conversationMode] = useConversationComposerMode(sessionId ?? null);
    const teamChatActive = conversationMode === "team_chat";

    const openedTabMentionOptions = useAtomValue(openedTabMentionOptionsAtom);
    const comments = useSessionCommentsContext();
    const mentionableMembers = comments?.mentionableMembers;
    const viewerUserId = comments?.viewerUserId ?? null;
    const teamChatMentionOptions = useMemo(
      () =>
        teamChatActive && mentionableMembers
          ? buildTeamChatMentionOptions(
              mentionableMembers,
              viewerUserId,
              t("conversation.mentionGroup")
            )
          : [],
      [teamChatActive, mentionableMembers, viewerUserId, t]
    );
    const mergedCustomMentionOptions = useMemo(
      () => [
        ...openedTabMentionOptions,
        ...(customMentionOptions ?? []),
        ...teamChatMentionOptions,
      ],
      [openedTabMentionOptions, customMentionOptions, teamChatMentionOptions]
    );

    const {
      composerInputRef,
      containerRef,
      contextMenuKeyboardHandlerRef,
      slashCommandKeyboardHandlerRef,
      setIsInputFocused,
      handleInputBlur,
      handleContentChange,
      compactHintVisible,
      canvasHintVisible,
      handleAtMention,
      handleAtMentionClose,
      isInputEmpty,
      showContextMenu,
      setShowContextMenu,
      atSearchQuery,
      setAtSearchQuery,
      handleAtSelect,
      handleCustomMentionSelect,
      customMentionOptions: activeCustomMentionOptions,
      showSlashMenu,
      handleSlashCommand,
      handleSlashCommandClose,
      handleSlashSelect,
      handleModeSelect,
      currentMode,
      includeProjectMode,
      filteredSlashItems,
      slashLoading,
      slashQuery,
      fileInputRef,
      handleUploadClick,
      handleFileUpload,
      isCiteCode,
      selectedCiteRange,
      citeFileName,
      clearCiteCode,
      handleDivSubmit,
      isWpGeneWorking,
      isPendingCancel,
      interruptSession,
      resumeSession,
      isHosted,
      canStopAgent,
      canResume,
      isSessionTerminal,
      dropTargetId,
      handleDragOver,
      handleDragLeave,
      handleDrop,
      replyInfo,
      setReplyInfo,
      currentRepoPath,
      skillWorkspacePaths,
      attachedImages,
      handleImagePaste,
      hasImages,
      clearAttachedImages,
      promptPolish,
    } = useInputArea({
      placeholder,
      sessionId: propSessionId,
      sessionScope,
      submitDisabled,
      onSubmitOverride: conversationSubmitOverride,
      customMentionOptions: mergedCustomMentionOptions,
      enableAgentInterceptors,
    });

    const currentTextEmpty = isInputEmpty();
    const currentInputEmpty = currentTextEmpty && !hasImages;
    const stopSuppressedForEmptyInput =
      disableStopWhenEmpty && currentInputEmpty && !isWpGeneWorking;
    const voiceFeatureEnabled = useAtomValue(voiceInputEnabledAtom);
    const [pinnedActionsVisible, setPinnedActionsVisible] = useAtom(
      pinnedActionsVisibleAtom
    );
    const handlePinnedActionsContextMenu =
      usePinnedActionsVisibilityContextMenu({
        visible: pinnedActionsVisible,
        onVisibleChange: setPinnedActionsVisible,
      });
    const isContextualPanel = presentation === "contextual";
    const isContextual = isContextualInputAreaPresentation(presentation);

    const {
      handleOpenContextMenu,
      handleContextMenuClose,
      handleKeyboardAtMention,
    } = useInputAreaMenus({
      composerInputRef,
      setShowContextMenu,
      setAtSearchQuery,
      handleAtMention,
    });
    const handleContextModeSelect = useCallback(
      (mode: Parameters<typeof handleModeSelect>[0]) => {
        handleModeSelect(mode);
        composerInputRef.current?.consumeMentionQuery();
        handleContextMenuClose();
      },
      [composerInputRef, handleContextMenuClose, handleModeSelect]
    );
    const handleContextImageUpload = useCallback(() => {
      composerInputRef.current?.consumeMentionQuery();
      handleUploadClick();
    }, [composerInputRef, handleUploadClick]);

    const attachedImageDataUrls = attachedImages.map((image) => image.dataUrl);
    const { editContainerRef, handleEditSubmit, handleEditKeyDown } =
      useEditMode({
        effectiveEditMode: isEditMode,
        isEditMode,
        initialContent,
        onEditSubmit,
        attachedImageDataUrls,
        clearAttachedImages,
        onEditCancel,
        composerInputRef,
      });
    const handleEditSendNow = useCallback(() => {
      if (!composerInputRef.current || !onEditSendNow) return;
      const text = composerInputRef.current.getTextWithPills().trim();
      if (!text) return;
      onEditSendNow(text, attachedImageDataUrls);
      if (attachedImageDataUrls.length > 0) clearAttachedImages();
    }, [
      attachedImageDataUrls,
      clearAttachedImages,
      onEditSendNow,
      composerInputRef,
    ]);

    const {
      handleContainerDragOver,
      handleContainerDragLeave,
      handleContainerDrop,
      isDragOver,
    } = useContainerDrag({
      handleDragOver,
      handleDragLeave,
      handleDrop,
      composerInputRef,
      containerRef,
      acceptDraggedPills,
    });

    // Republish the editor handle to an external owner. No dependency array:
    // the handle is created by `ComposerInput`'s own `useImperativeHandle`, so
    // re-mirroring after every render is what keeps a stale object from being
    // handed to a drop target that fires much later.
    useEffect(() => {
      if (!externalComposerInputRef) return undefined;
      externalComposerInputRef.current = composerInputRef.current;
      return () => {
        externalComposerInputRef.current = null;
      };
    });

    const { voice, showVoiceUi } = useInputAreaVoice({
      composerInputRef,
      containerRef,
      enabled: showAgentControls && voiceFeatureEnabled,
      isEditMode,
    });

    const visibleSlashItems = useMemo(
      () =>
        slashItemCategories
          ? filteredSlashItems.filter((item) =>
              slashItemCategories.includes(item.category)
            )
          : filteredSlashItems,
      [filteredSlashItems, slashItemCategories]
    );

    // Double-press Escape to stop the running turn. Active only while a turn
    // is running and stoppable; a single Escape is inert.
    useStopOnDoubleEscape(isWpGeneWorking && canStopAgent, interruptSession);

    // Cursor IDE sessions are read-only; no interactive model/mode pill.
    const modelPill =
      !showAgentControls ||
      teamChatActive ||
      (isCursorIde && sessionId) ? null : (
        <ModelPill />
      );
    // Always visible in-session: the composer picker is the only surface
    // that can move a session onto the Project product mode (§5.2), and a
    // hidden-at-Build pill would make that entry unreachable.
    const modePill =
      !showAgentControls || (isCursorIde && sessionId) ? null : (
        <>
          <ConversationModePill sessionId={sessionId ?? null} />
          {!teamChatActive && <ModePill resetToDefaultOnClick />}
        </>
      );
    const clearReplyInfo = useCallback(
      () => setReplyInfo({ isReply: false }),
      [setReplyInfo]
    );
    // Queue-vs-direct is decided by handleSessChatSubmit against the
    // turn-lifecycle FSM — the composer just forwards the captured text.
    const submitMessage = useCallback(
      (capturedText?: string) => {
        void handleDivSubmit({ capturedText });
      },
      [handleDivSubmit]
    );

    return (
      <div
        ref={containerRef}
        data-chat-input-shell
        data-testid="chat-input"
        data-image-owner-id={allowFileAttachments ? dropTargetId : undefined}
        className="flex w-full flex-col"
        onKeyDown={isEditMode ? handleEditKeyDown : undefined}
        onDragOver={handleContainerDragOver}
        onDragLeave={handleContainerDragLeave}
        onDrop={handleContainerDrop}
        onContextMenu={
          !isEditMode && !isContextual
            ? handlePinnedActionsContextMenu
            : undefined
        }
      >
        <div className="relative flex flex-col gap-0.5">
          {!isContextual && (
            <InputAreaTopRows
              isEditMode={isEditMode}
              omitChatHeader={omitChatHeader}
              topRowPills={topRowPills}
              topRowTrailingContent={topRowTrailingContent}
              composerInputRef={composerInputRef}
              sessionId={sessionId}
              showPinnedActions={pinnedActionsVisible}
              skillWorkspacePaths={skillWorkspacePaths}
            />
          )}
          <QuietEditStatus
            isEditMode={isEditMode}
            quietEditSurface={quietEditSurface}
            showEditHeader={showEditHeader}
            editLabel={editLabel}
          />
          {!isEditMode && statusBanners}

          <ComposerShell
            ref={isEditMode ? editContainerRef : composerShellRef}
            data-composer-menu-anchor
            data-chat-drop-target
            data-chat-drop-target-id={dropTargetId}
            data-chat-file-drop-disabled={
              allowFileAttachments ? undefined : true
            }
            data-testid={isEditMode ? "chat-message-edit-composer" : undefined}
            variant={getComposerShellVariant({
              isEditMode,
              quietEditSurface,
              surfaceBg,
            })}
            className={getComposerShellClassName({
              isDragOver,
              isEditMode,
              quietEditSurface,
            })}
          >
            {isEditMode && !quietEditSurface && showEditHeader && (
              <EditModeHeader
                editLabel={editLabel ?? t("input.editingSentMessage")}
                editHeaderActions={editHeaderActions}
                onEditCancel={onEditCancel}
                onEditSubmit={handleEditSubmit}
              />
            )}

            <EditImagePreviews
              isEditMode={isEditMode}
              editImages={editImages}
              dropTargetId={dropTargetId}
              onRemoveEditImage={onRemoveEditImage}
            />

            {isEditMode ? (
              <EditComposerBar
                composerInputRef={composerInputRef}
                showContextMenu={showContextMenu}
                contextMenuKeyboardHandlerRef={contextMenuKeyboardHandlerRef}
                showSlashMenu={showSlashMenu}
                slashCommandKeyboardHandlerRef={slashCommandKeyboardHandlerRef}
                onSlashCommand={handleSlashCommand}
                onSlashCommandClose={handleSlashCommandClose}
                onContentChange={handleContentChange}
                onAtMention={handleKeyboardAtMention}
                onAtMentionClose={handleAtMentionClose}
                onSubmit={handleEditSubmit}
                onFocus={() => setIsInputFocused(true)}
                onBlur={handleInputBlur}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onImagePaste={
                  allowFileAttachments ? handleImagePaste : undefined
                }
                onAddContent={handleOpenContextMenu}
                isCiteCode={isCiteCode}
                selectedCiteRange={selectedCiteRange}
                citeFileName={citeFileName}
                onClearCiteCode={clearCiteCode}
                replyInfo={replyInfo}
                onClearReplyInfo={clearReplyInfo}
                modePill={modePill}
                modelPill={modelPill}
                onEditCancel={onEditCancel}
                onEditSendNow={onEditSendNow ? handleEditSendNow : undefined}
                quietEditSurface={quietEditSurface}
                isInputEmpty={isInputEmpty()}
                hasImages={hasImages}
                isHosted={isHosted}
                canStopAgent={canStopAgent}
                canResume={canResume}
                onInterrupt={interruptSession}
                onResume={resumeSession}
                isCursorIde={isCursorIde}
              />
            ) : (
              <NormalComposerContent
                composerInputRef={composerInputRef}
                showContextMenu={showContextMenu}
                contextMenuKeyboardHandlerRef={contextMenuKeyboardHandlerRef}
                showSlashMenu={showSlashMenu}
                slashCommandKeyboardHandlerRef={slashCommandKeyboardHandlerRef}
                onSlashCommand={handleSlashCommand}
                onSlashCommandClose={handleSlashCommandClose}
                onContentChange={handleContentChange}
                onAtMention={handleKeyboardAtMention}
                onAtMentionClose={handleAtMentionClose}
                onSubmit={submitMessage}
                onFocus={() => setIsInputFocused(true)}
                onBlur={handleInputBlur}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onImagePaste={
                  allowFileAttachments ? handleImagePaste : undefined
                }
                onAddContent={handleOpenContextMenu}
                isCiteCode={isCiteCode}
                selectedCiteRange={selectedCiteRange}
                citeFileName={citeFileName}
                onClearCiteCode={clearCiteCode}
                replyInfo={replyInfo}
                onClearReplyInfo={clearReplyInfo}
                modePill={modePill}
                modelPill={modelPill}
                isHosted={isHosted}
                canStopAgent={canStopAgent}
                canResume={canResume}
                onInterrupt={interruptSession}
                onResume={resumeSession}
                isCursorIde={isCursorIde}
                showVoiceUi={showVoiceUi}
                voice={voice}
                currentRepoPath={currentRepoPath}
                contextualPanel={isContextualPanel}
                inlineLeadingContent={isContextual ? topRowPills : undefined}
                placeholder={placeholder}
                trailingHint={
                  compactHintVisible
                    ? t("input.compactArgHint")
                    : canvasHintVisible
                      ? t("input.canvasArgHint", "what to build")
                      : undefined
                }
                currentInputEmpty={currentInputEmpty}
                stopSuppressedForEmptyInput={stopSuppressedForEmptyInput}
                isWpGeneWorking={isWpGeneWorking}
                isPendingCancel={isPendingCancel}
                isSessionTerminal={isSessionTerminal}
                voiceFeatureEnabled={voiceFeatureEnabled}
                dropTargetId={dropTargetId}
                promptPolish={promptPolish}
                promptPolishDisabled={currentTextEmpty}
                submitDisabled={submitDisabled}
                showAgentControls={showAgentControls}
                showImageAttachments={allowFileAttachments}
                autoFocus={autoFocus}
              />
            )}
          </ComposerShell>
        </div>

        <InputAreaPortals
          contextMenuVisible={showContextMenu}
          containerRef={containerRef}
          onContextMenuClose={handleContextMenuClose}
          onAtSelect={handleAtSelect}
          onImageUpload={
            allowFileAttachments ? handleContextImageUpload : undefined
          }
          customMentionOptions={activeCustomMentionOptions}
          onCustomMentionSelect={handleCustomMentionSelect}
          atSearchQuery={atSearchQuery}
          currentRepoPath={currentRepoPath}
          contextMenuKeyboardHandlerRef={contextMenuKeyboardHandlerRef}
          isEditMode={isEditMode}
          showSlashMenu={showSlashMenu}
          filteredSlashItems={visibleSlashItems}
          slashLoading={slashLoading}
          currentMode={currentMode}
          includeProjectMode={includeProjectMode}
          slashQuery={slashQuery}
          onSlashCommandClose={handleSlashCommandClose}
          onSlashSelect={handleSlashSelect}
          onContextModeSelect={handleContextModeSelect}
          slashCommandKeyboardHandlerRef={slashCommandKeyboardHandlerRef}
        />

        {allowFileAttachments && (
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            data-testid="chat-file-upload-input"
            onChange={handleFileUpload}
          />
        )}
      </div>
    );
  }
);

InputAreaInteractive.displayName = "InputAreaInteractive";

export default InputArea;
