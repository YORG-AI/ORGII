import { useAtomValue } from "jotai";
import React, { memo, useCallback, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

import ComposerShell from "@src/components/ComposerShell";
import { useInputArea } from "@src/engines/ChatPanel/hooks/useInputArea";
import type {
  CustomMentionOption,
  SubmitOverrideInput,
} from "@src/engines/ChatPanel/hooks/useInputArea/types";
import { useSessionDiscovery } from "@src/engines/SessionCore";
import { useSessionId } from "@src/engines/SessionCore/hooks/session";
import { voiceInputEnabledAtom } from "@src/store/platform/voiceInputAtom";
import { chatPanelMaximizedAtom } from "@src/store/ui/chatPanelAtom";
import { isCursorIdeSession } from "@src/util/session/sessionDispatch";

import CursorModePill from "./components/CursorModePill";
import CursorModelPill from "./components/CursorModelPill";
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
import SessionReadOnlyBar from "./components/SessionReadOnlyBar";
import { useContainerDrag } from "./hooks/useContainerDrag";
import { useEditMode } from "./hooks/useEditMode";
import { useEditorExpansion } from "./hooks/useEditorExpansion";
import { useInputAreaMenus } from "./hooks/useInputAreaMenus";
import { useInputAreaVoice } from "./hooks/useInputAreaVoice";
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
  disableStopWhenEmpty?: boolean;
  submitDisabled?: boolean;
  sessionScope?: "active" | "none";
  /**
   * Set by the bottom-anchored floating composer so its + / slash / @ menus
   * open upward even in queue-edit mode (there is no room beneath it).
   */
  bottomAnchored?: boolean;
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
    return (
      <SessionReadOnlyBar
        pills={
          <>
            <CursorModelPill sessionId={sessionId} />
            <CursorModePill sessionId={sessionId} />
          </>
        }
      />
    );
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
    chatPanelPosition = "right",
    sessionId: propSessionId,
    onSubmitOverride,
    customMentionOptions,
    topRowPills,
    topRowTrailingContent,
    statusBanners,
    composerShellRef,
    disableStopWhenEmpty = false,
    submitDisabled = false,
    sessionScope = "active",
    bottomAnchored = false,
  }) => {
    const { t } = useTranslation("sessions");

    const { sessionId } = useSessionId({ propSessionId });
    const isCursorIde = sessionId ? isCursorIdeSession(sessionId) : false;

    const openedTabMentionOptions = useAtomValue(openedTabMentionOptionsAtom);
    const mergedCustomMentionOptions = useMemo(
      () => [...openedTabMentionOptions, ...(customMentionOptions ?? [])],
      [openedTabMentionOptions, customMentionOptions]
    );

    const {
      composerInputRef,
      containerRef,
      contextMenuKeyboardHandlerRef,
      slashCommandKeyboardHandlerRef,
      plusSlashCommandKeyboardHandlerRef,
      setIsInputFocused,
      handleInputBlur,
      handleContentChange,
      compactHintVisible,
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
      handleSlashAppendSelect,
      handleModeSelect,
      currentMode,
      filteredSlashItems,
      slashLoading,
      slashQuery,
      prefetchSlashItems,
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
      onSubmitOverride,
      customMentionOptions: mergedCustomMentionOptions,
    });

    const currentTextEmpty = isInputEmpty();
    const currentInputEmpty = currentTextEmpty && !hasImages;
    const stopSuppressedForEmptyInput =
      disableStopWhenEmpty && currentInputEmpty && !isWpGeneWorking;
    const mentionTreePosition = chatPanelPosition === "left" ? "right" : "left";
    const voiceFeatureEnabled = useAtomValue(voiceInputEnabledAtom);
    const isChatPanelMaximized = useAtomValue(chatPanelMaximizedAtom);

    const {
      showPlusSlashMenu,
      plusSlashQuery,
      contextMenuKeyboardOpened,
      handleOpenSkillsTools,
      handleOpenContextMenu,
      handlePlusSlashClose,
      handlePlusSlashQueryChange,
      handleContextMenuClose,
      handleKeyboardAtMention,
    } = useInputAreaMenus({
      prefetchSlashItems,
      setShowContextMenu,
      setAtSearchQuery,
      handleAtMention,
    });

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
    });

    const {
      editorMultiline,
      suppressToolbarHover,
      acknowledgeToolbarHover,
      onEditorContentChange,
      onEditorBlur,
      observeCompact,
    } = useEditorExpansion({
      containerRef,
      composerInputRef,
      handleContentChange,
      handleInputBlur,
    });

    const { voice, showVoiceUi } = useInputAreaVoice({
      composerInputRef,
      containerRef,
      enabled: voiceFeatureEnabled,
      isEditMode,
    });

    const isCursorCompactRow = useMemo(
      () =>
        isChatPanelMaximized &&
        !isEditMode &&
        !hasImages &&
        !isCiteCode &&
        !replyInfo.isReply &&
        !editorMultiline,
      [
        isChatPanelMaximized,
        isEditMode,
        hasImages,
        isCiteCode,
        replyInfo.isReply,
        editorMultiline,
      ]
    );
    const compactShell = !isEditMode && isCursorCompactRow;

    useEffect(() => {
      if (!suppressToolbarHover) return;
      window.addEventListener("pointermove", acknowledgeToolbarHover, {
        once: true,
      });
      return () => {
        window.removeEventListener("pointermove", acknowledgeToolbarHover);
      };
    }, [acknowledgeToolbarHover, suppressToolbarHover]);

    useEffect(() => {
      observeCompact(isCursorCompactRow);
    }, [isCursorCompactRow, observeCompact]);

    const modelPill =
      isCursorIde && sessionId ? (
        <CursorModelPill sessionId={sessionId} />
      ) : (
        <ModelPill />
      );
    const modePill =
      isCursorIde && sessionId ? (
        <CursorModePill sessionId={sessionId} />
      ) : (
        <ModePill resetToDefaultOnClick />
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
        data-image-owner-id={dropTargetId}
        className="flex w-full flex-col"
        onKeyDown={isEditMode ? handleEditKeyDown : undefined}
        onDragOver={handleContainerDragOver}
        onDragLeave={handleContainerDragLeave}
        onDrop={handleContainerDrop}
      >
        <div className="relative flex flex-col gap-0.5">
          <InputAreaTopRows
            isEditMode={isEditMode}
            omitChatHeader={omitChatHeader}
            topRowPills={topRowPills}
            topRowTrailingContent={topRowTrailingContent}
            composerInputRef={composerInputRef}
            sessionId={sessionId}
            skillWorkspacePaths={skillWorkspacePaths}
          />
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
            data-testid={isEditMode ? "chat-message-edit-composer" : undefined}
            variant={getComposerShellVariant({
              compactShell,
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
                showPlusSlashMenu={showPlusSlashMenu}
                plusSlashCommandKeyboardHandlerRef={
                  plusSlashCommandKeyboardHandlerRef
                }
                onSlashCommand={handleSlashCommand}
                onSlashCommandClose={handleSlashCommandClose}
                onPlusSlashClose={handlePlusSlashClose}
                onContentChange={handleContentChange}
                onAtMention={handleKeyboardAtMention}
                onAtMentionClose={handleAtMentionClose}
                onSubmit={handleEditSubmit}
                onFocus={() => setIsInputFocused(true)}
                onBlur={handleInputBlur}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onImagePaste={handleImagePaste}
                onAddContent={handleOpenContextMenu}
                onUpload={handleUploadClick}
                onOpenSkillsTools={handleOpenSkillsTools}
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
                sessionId={sessionId}
              />
            ) : (
              <NormalComposerContent
                composerInputRef={composerInputRef}
                showContextMenu={showContextMenu}
                contextMenuKeyboardHandlerRef={contextMenuKeyboardHandlerRef}
                showSlashMenu={showSlashMenu}
                slashCommandKeyboardHandlerRef={slashCommandKeyboardHandlerRef}
                showPlusSlashMenu={showPlusSlashMenu}
                plusSlashCommandKeyboardHandlerRef={
                  plusSlashCommandKeyboardHandlerRef
                }
                onSlashCommand={handleSlashCommand}
                onSlashCommandClose={handleSlashCommandClose}
                onPlusSlashClose={handlePlusSlashClose}
                onContentChange={onEditorContentChange}
                onAtMention={handleKeyboardAtMention}
                onAtMentionClose={handleAtMentionClose}
                onSubmit={submitMessage}
                onFocus={() => setIsInputFocused(true)}
                onBlur={onEditorBlur}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onImagePaste={handleImagePaste}
                onAddContent={handleOpenContextMenu}
                onUpload={handleUploadClick}
                onOpenSkillsTools={handleOpenSkillsTools}
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
                sessionId={sessionId}
                showVoiceUi={showVoiceUi}
                voice={voice}
                currentRepoPath={currentRepoPath}
                isCursorCompactRow={isCursorCompactRow}
                suppressToolbarHover={suppressToolbarHover}
                placeholder={placeholder}
                trailingHint={
                  compactHintVisible ? t("input.compactArgHint") : undefined
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
              />
            )}
          </ComposerShell>
        </div>

        <InputAreaPortals
          contextMenuVisible={showContextMenu}
          containerRef={containerRef}
          onContextMenuClose={handleContextMenuClose}
          onAtSelect={handleAtSelect}
          customMentionOptions={activeCustomMentionOptions}
          onCustomMentionSelect={handleCustomMentionSelect}
          atSearchQuery={atSearchQuery}
          contextMenuKeyboardOpened={contextMenuKeyboardOpened}
          currentRepoPath={currentRepoPath}
          contextMenuKeyboardHandlerRef={contextMenuKeyboardHandlerRef}
          mentionTreePosition={mentionTreePosition}
          isEditMode={isEditMode}
          showSlashMenu={showSlashMenu}
          filteredSlashItems={filteredSlashItems}
          slashLoading={slashLoading}
          currentMode={currentMode}
          slashQuery={slashQuery}
          onSlashCommandClose={handleSlashCommandClose}
          onSlashSelect={handleSlashSelect}
          onModeSelect={handleModeSelect}
          slashCommandKeyboardHandlerRef={slashCommandKeyboardHandlerRef}
          onImageUpload={handleUploadClick}
          showPlusSlashMenu={showPlusSlashMenu}
          plusSlashQuery={plusSlashQuery}
          onPlusSlashClose={handlePlusSlashClose}
          onSlashAppendSelect={handleSlashAppendSelect}
          plusSlashCommandKeyboardHandlerRef={
            plusSlashCommandKeyboardHandlerRef
          }
          onPlusSlashQueryChange={handlePlusSlashQueryChange}
          bottomAnchored={bottomAnchored}
        />

        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          data-testid="chat-file-upload-input"
          onChange={handleFileUpload}
        />
      </div>
    );
  }
);

InputAreaInteractive.displayName = "InputAreaInteractive";

export default InputArea;
