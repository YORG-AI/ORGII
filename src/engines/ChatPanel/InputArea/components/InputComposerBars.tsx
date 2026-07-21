import { RotateCcw, X } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import ComposerBar from "@src/components/ComposerBar";
import type { ComposerInputRef } from "@src/components/ComposerInput";
import { VoiceInputButton, VoiceRecordingBar } from "@src/components/Voice";
import type { PromptPolishControl } from "@src/engines/ChatPanel/hooks/useInputArea/types";
import type { UseVoiceInputResult } from "@src/hooks/voice";

import CiteCodePreview from "./CiteCodePreview";
import ImageAttachmentPreview from "./ImageAttachmentPreview";
import InputActions from "./InputActions";
import InputEditor from "./InputEditor";
import PromptPolishButton from "./PromptPolishButton";
import ReplyInfoDisplay from "./ReplyInfoDisplay";
import WorktreeBranchPill from "./WorktreeBranchPill";

interface SharedComposerBarProps {
  composerInputRef: React.RefObject<ComposerInputRef | null>;
  showContextMenu: boolean;
  contextMenuKeyboardHandlerRef: React.MutableRefObject<
    ((event: React.KeyboardEvent) => boolean) | null
  >;
  showSlashMenu: boolean;
  slashCommandKeyboardHandlerRef: React.MutableRefObject<
    ((event: KeyboardEvent) => boolean) | null
  >;
  showPlusSlashMenu: boolean;
  plusSlashCommandKeyboardHandlerRef: React.MutableRefObject<
    ((event: KeyboardEvent) => boolean) | null
  >;
  onSlashCommand: (query: string) => void;
  onSlashCommandClose: () => void;
  onPlusSlashClose: () => void;
  onAtMention: (query: string, position: { x: number; y: number }) => void;
  onAtMentionClose: () => void;
  onFocus: () => void;
  onDragOver: (event: React.DragEvent<HTMLDivElement>) => void;
  onDragLeave: (event: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (event: React.DragEvent<HTMLDivElement>) => void;
  onImagePaste: (files: File[]) => void;
  onAddContent: () => void;
  onUpload: () => void;
  onOpenSkillsTools: () => void;
  isCiteCode: boolean;
  selectedCiteRange: { start: number; end: number } | null;
  citeFileName: string;
  onClearCiteCode: () => void;
  replyInfo: { isReply: boolean };
  onClearReplyInfo: () => void;
  modePill: React.ReactNode;
  modelPill: React.ReactNode;
  isHosted: boolean;
  canStopAgent: boolean;
  canResume: boolean;
  onInterrupt: () => Promise<void>;
  onResume: () => Promise<void>;
  isCursorIde: boolean;
}

interface EditComposerBarProps extends SharedComposerBarProps {
  onContentChange: (text: string) => void;
  onBlur: () => void;
  onSubmit: (capturedText?: string) => void;
  onEditCancel?: () => void;
  onEditSendNow?: () => void;
  quietEditSurface: boolean;
  isInputEmpty: boolean;
  hasImages: boolean;
}

const ComposerPrefixes: React.FC<
  Pick<
    SharedComposerBarProps,
    | "isCiteCode"
    | "selectedCiteRange"
    | "citeFileName"
    | "onClearCiteCode"
    | "replyInfo"
    | "onClearReplyInfo"
  >
> = ({
  isCiteCode,
  selectedCiteRange,
  citeFileName,
  onClearCiteCode,
  replyInfo,
  onClearReplyInfo,
}) => (
  <>
    <CiteCodePreview
      isCiteCode={isCiteCode}
      selectedCiteRange={selectedCiteRange}
      citeFileName={citeFileName}
      onClear={onClearCiteCode}
    />
    <ReplyInfoDisplay replyInfo={replyInfo} onClose={onClearReplyInfo} />
  </>
);

export const EditComposerBar: React.FC<EditComposerBarProps> = ({
  composerInputRef,
  showContextMenu,
  contextMenuKeyboardHandlerRef,
  showSlashMenu,
  slashCommandKeyboardHandlerRef,
  showPlusSlashMenu,
  plusSlashCommandKeyboardHandlerRef,
  onSlashCommand,
  onSlashCommandClose,
  onPlusSlashClose,
  onContentChange,
  onAtMention,
  onAtMentionClose,
  onSubmit,
  onFocus,
  onBlur,
  onDragOver,
  onDragLeave,
  onDrop,
  onImagePaste,
  onAddContent,
  onUpload,
  onOpenSkillsTools,
  isCiteCode,
  selectedCiteRange,
  citeFileName,
  onClearCiteCode,
  replyInfo,
  onClearReplyInfo,
  modePill,
  modelPill,
  onEditCancel,
  onEditSendNow,
  quietEditSurface,
  isInputEmpty,
  hasImages,
  isHosted,
  canStopAgent,
  canResume,
  onInterrupt,
  onResume,
  isCursorIde,
}) => {
  const { t } = useTranslation("sessions");

  return (
    <ComposerBar
      onAddContent={onAddContent}
      onUpload={onUpload}
      onOpenSkillsTools={onOpenSkillsTools}
      dropdownDirection="down"
      toolbarItemGap={false}
      showContextInfo={!isCursorIde}
      editorSlot={
        <InputEditor
          composerInputRef={composerInputRef}
          showContextMenu={showContextMenu}
          contextMenuKeyboardHandlerRef={contextMenuKeyboardHandlerRef}
          showSlashMenu={showSlashMenu}
          slashCommandKeyboardHandlerRef={slashCommandKeyboardHandlerRef}
          showPlusSlashMenu={showPlusSlashMenu}
          plusSlashCommandKeyboardHandlerRef={
            plusSlashCommandKeyboardHandlerRef
          }
          onSlashCommand={onSlashCommand}
          onSlashCommandClose={onSlashCommandClose}
          onInputMouseDown={onPlusSlashClose}
          slashTriggerMode="command"
          onContentChange={onContentChange}
          onAtMention={onAtMention}
          onAtMentionClose={onAtMentionClose}
          onSubmit={onSubmit}
          onFocus={onFocus}
          onBlur={onBlur}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          placeholder={t("input.editPlaceholder")}
          onImagePaste={onImagePaste}
        />
      }
      leftPrefix={
        <ComposerPrefixes
          isCiteCode={isCiteCode}
          selectedCiteRange={selectedCiteRange}
          citeFileName={citeFileName}
          onClearCiteCode={onClearCiteCode}
          replyInfo={replyInfo}
          onClearReplyInfo={onClearReplyInfo}
        />
      }
      pills={
        <>
          {modePill}
          {modelPill}
        </>
      }
      submitButton={
        onEditSendNow ? (
          <div className="flex items-center gap-1">
            <Button
              variant="tertiary"
              size="mini"
              shape="circle"
              iconOnly
              htmlType="button"
              icon={<X size={13} strokeWidth={2} />}
              aria-label={t("common:actions.cancel")}
              className="enabled:hover:bg-fill-3 enabled:hover:text-text-1"
              onClick={onEditCancel}
            />
            <Button
              variant="tertiary"
              size="mini"
              shape="round"
              htmlType="button"
              className="enabled:hover:bg-fill-3 enabled:hover:text-text-1"
              onClick={onEditSendNow}
            >
              {t("common:actions.sendNow")}
            </Button>
            <Button
              variant="primary"
              size="mini"
              shape="round"
              htmlType="button"
              onClick={() => onSubmit()}
            >
              {t("common:actions.save")}
            </Button>
          </div>
        ) : quietEditSurface ? (
          <Button
            variant="warning"
            size="mini"
            shape="round"
            htmlType="button"
            icon={<RotateCcw size={13} strokeWidth={2} />}
            onClick={() => onSubmit()}
          >
            {t("common:actions.resend")}
          </Button>
        ) : (
          <InputActions
            isInputEmpty={isInputEmpty && !hasImages}
            isWpGeneWorking={false}
            isPendingCancel={false}
            isHosted={isHosted}
            canStopAgent={canStopAgent}
            canResume={canResume}
            isSessionTerminal={false}
            onSubmit={onSubmit}
            onInterrupt={onInterrupt}
            onResume={onResume}
          />
        )
      }
    />
  );
};

interface NormalComposerContentProps extends SharedComposerBarProps {
  showVoiceUi: boolean;
  voice: UseVoiceInputResult;
  currentRepoPath?: string;
  isCursorCompactRow: boolean;
  suppressToolbarHover: boolean;
  onContentChange: (text: string) => void;
  onBlur: () => void;
  onSubmit: (capturedText?: string) => void;
  placeholder?: string;
  /** Inline ghost hint after the last content node (see ComposerInput) */
  trailingHint?: string | null;
  currentInputEmpty: boolean;
  stopSuppressedForEmptyInput: boolean;
  isWpGeneWorking: boolean;
  isPendingCancel: boolean;
  isSessionTerminal: boolean;
  voiceFeatureEnabled: boolean;
  dropTargetId: string;
  promptPolish: PromptPolishControl;
  promptPolishDisabled: boolean;
  submitDisabled?: boolean;
}

export const NormalComposerContent: React.FC<NormalComposerContentProps> = ({
  composerInputRef,
  showContextMenu,
  contextMenuKeyboardHandlerRef,
  showSlashMenu,
  slashCommandKeyboardHandlerRef,
  showPlusSlashMenu,
  plusSlashCommandKeyboardHandlerRef,
  onSlashCommand,
  onSlashCommandClose,
  onPlusSlashClose,
  onContentChange,
  onAtMention,
  onAtMentionClose,
  onSubmit,
  onFocus,
  onBlur,
  onDragOver,
  onDragLeave,
  onDrop,
  onImagePaste,
  onAddContent,
  onUpload,
  onOpenSkillsTools,
  isCiteCode,
  selectedCiteRange,
  citeFileName,
  onClearCiteCode,
  replyInfo,
  onClearReplyInfo,
  modePill,
  modelPill,
  isHosted,
  canStopAgent,
  canResume,
  onInterrupt,
  onResume,
  isCursorIde,
  showVoiceUi,
  voice,
  currentRepoPath,
  isCursorCompactRow,
  suppressToolbarHover,
  placeholder,
  trailingHint,
  currentInputEmpty,
  stopSuppressedForEmptyInput,
  isWpGeneWorking,
  isPendingCancel,
  isSessionTerminal,
  voiceFeatureEnabled,
  dropTargetId,
  promptPolish,
  promptPolishDisabled,
  submitDisabled,
}) => {
  const { t } = useTranslation("sessions");

  return (
    <div className="flex min-h-0 w-full flex-col">
      <ImageAttachmentPreview ownerId={dropTargetId} />
      {showVoiceUi ? (
        <VoiceRecordingBar
          elapsedSeconds={voice.elapsedSeconds}
          onCancel={voice.cancel}
          onAccept={voice.stop}
          onAddContent={onAddContent}
          compact={isCursorCompactRow}
        />
      ) : (
        <ComposerBar
          onAddContent={onAddContent}
          onUpload={onUpload}
          onOpenSkillsTools={onOpenSkillsTools}
          dropdownDirection="up"
          toolbarItemGap={false}
          repoPath={currentRepoPath}
          inlineLayout={isCursorCompactRow}
          showContextInfo={!isCursorIde}
          editorSlot={
            <InputEditor
              key="chat-panel-input-editor"
              composerInputRef={composerInputRef}
              showContextMenu={showContextMenu}
              contextMenuKeyboardHandlerRef={contextMenuKeyboardHandlerRef}
              showSlashMenu={showSlashMenu}
              slashCommandKeyboardHandlerRef={slashCommandKeyboardHandlerRef}
              showPlusSlashMenu={showPlusSlashMenu}
              plusSlashCommandKeyboardHandlerRef={
                plusSlashCommandKeyboardHandlerRef
              }
              onSlashCommand={onSlashCommand}
              onSlashCommandClose={onSlashCommandClose}
              onInputMouseDown={onPlusSlashClose}
              onContentChange={onContentChange}
              onAtMention={onAtMention}
              onAtMentionClose={onAtMentionClose}
              onSubmit={onSubmit}
              onFocus={onFocus}
              onBlur={onBlur}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              placeholder={placeholder || t("input.defaultPlaceholder")}
              trailingHint={trailingHint}
              onImagePaste={onImagePaste}
              compact={isCursorCompactRow}
            />
          }
          leftPrefix={
            <ComposerPrefixes
              isCiteCode={isCiteCode}
              selectedCiteRange={selectedCiteRange}
              citeFileName={citeFileName}
              onClearCiteCode={onClearCiteCode}
              replyInfo={replyInfo}
              onClearReplyInfo={onClearReplyInfo}
            />
          }
          pills={
            <div
              className={`inline-flex items-center ${
                suppressToolbarHover ? "pointer-events-none" : ""
              }`.trim()}
            >
              {modePill}
              {modelPill}
              <WorktreeBranchPill />
            </div>
          }
          submitButton={
            <div className="flex h-7 items-center gap-0.5">
              <PromptPolishButton
                control={promptPolish}
                disabled={promptPolishDisabled}
              />
              {voiceFeatureEnabled && (
                <VoiceInputButton
                  onPressStart={voice.start}
                  onPressEnd={voice.stop}
                  disabled={!voice.isSupported}
                />
              )}
              <InputActions
                isInputEmpty={currentInputEmpty}
                isWpGeneWorking={
                  stopSuppressedForEmptyInput ? false : isWpGeneWorking
                }
                isPendingCancel={
                  stopSuppressedForEmptyInput ? false : isPendingCancel
                }
                isHosted={isHosted}
                canStopAgent={
                  stopSuppressedForEmptyInput ? false : canStopAgent
                }
                canResume={canResume}
                isSessionTerminal={isSessionTerminal}
                onSubmit={onSubmit}
                onInterrupt={onInterrupt}
                onResume={onResume}
                submitDisabled={submitDisabled}
              />
            </div>
          }
        />
      )}
    </div>
  );
};
