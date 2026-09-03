import React, { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import ComposerBarLayout from "@src/components/ComposerBar/ComposerBarLayout";
import ComposerSubmitButton from "@src/components/ComposerBar/ComposerSubmitButton";
import ComposerShell from "@src/components/ComposerShell";
import Textarea from "@src/components/Textarea";
import { VoiceInputButton, VoiceRecordingBar } from "@src/components/Voice";
import {
  COMPOSER_BOTTOM_DOCK_PADDING_CLASS,
  COMPOSER_HORIZONTAL_GUTTER_CLASS,
  MOBILE_COMPOSER_CONTENT_INSET_PX,
  MOBILE_COMPOSER_CONTENT_INSET_X_CLASS,
} from "@src/config/composerStackTokens";
import {
  INPUT_AREA_CONTROL_GROUP_CLASS,
  INPUT_AREA_EDITOR_HEIGHT,
} from "@src/config/inputAreaTokens";
import { type VoiceInputError, useVoiceInput } from "@src/hooks/voice";
import type { MobileSendAttachment } from "@src/modules/MobileRemote/connection/types";

import { MobileComposerAttachmentButton } from "./MobileComposerAttachmentButton";
import { MobileComposerImagePreview } from "./MobileComposerImagePreview";
import { MobileModelPicker } from "./MobileModelPicker";
import type { MobileModelPickerProps } from "./MobileModelPicker";
import { useMobileComposerImages } from "./useMobileComposerImages";

const MOBILE_COMPOSER_EDITOR_MIN_HEIGHT = 36;

export interface MobileComposerProps {
  disabled?: boolean;
  disabledReason?: string;
  statusMessage?: string;
  statusTone?: "neutral" | "error";
  onSend?: (
    content: string,
    attachments?: MobileSendAttachment[]
  ) => void | Promise<void>;
  modelPicker?: Omit<
    MobileModelPickerProps,
    "disabled" | "embedded" | "disabledReason"
  >;
}

export function MobileComposer({
  disabled = false,
  disabledReason,
  statusMessage,
  statusTone = "neutral",
  onSend,
  modelPicker,
}: MobileComposerProps) {
  const { t } = useTranslation("sessions");
  const { t: tVoice } = useTranslation("sessions", { keyPrefix: "input" });
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string>();
  const [voiceError, setVoiceError] = useState<string>();

  const handleVoiceCommit = useCallback((transcript: string) => {
    const trimmed = transcript.trim();
    if (!trimmed) return;
    setVoiceError(undefined);
    setDraft((existing) => {
      const separator =
        existing.length === 0 || /\s$/.test(existing) ? "" : " ";
      return `${existing}${separator}${trimmed}`;
    });
  }, []);

  const handleVoiceError = useCallback(
    (err: VoiceInputError) => {
      if (err.code === "permission-denied") {
        setVoiceError(
          tVoice("voiceErrorPermission", "Microphone permission denied.")
        );
      } else if (err.code === "unsupported") {
        setVoiceError(
          tVoice("voiceErrorUnsupported", "Voice input is not supported here.")
        );
      } else if (err.code === "audio-capture") {
        setVoiceError(tVoice("voiceErrorAudio", "No microphone detected."));
      } else if (err.code === "no-speech" || err.code === "aborted") {
        return;
      } else {
        setVoiceError(
          tVoice("voiceErrorGeneric", "Voice input failed. Please try again.")
        );
      }
    },
    [tVoice]
  );

  const voice = useVoiceInput({
    onCommit: handleVoiceCommit,
    onError: handleVoiceError,
  });

  const attachments = useMobileComposerImages();

  const handleSend = useCallback(async () => {
    if (disabled || submitting || attachments.processing) return;
    const trimmed = draft.trim();
    const pendingAttachments = attachments.toSendAttachments();
    if (!trimmed && pendingAttachments.length === 0) return;
    setSubmitting(true);
    setSubmitError(undefined);
    try {
      await onSend?.(trimmed, pendingAttachments);
      setDraft((current) => (current === draft ? "" : current));
      attachments.clearImages();
    } catch (error) {
      setSubmitError(
        error instanceof Error
          ? error.message
          : t("chat.sendFailed", "Message could not be sent")
      );
    } finally {
      setSubmitting(false);
    }
  }, [attachments, disabled, draft, onSend, submitting, t]);

  const visibleStatus =
    attachments.error ?? voiceError ?? submitError ?? statusMessage;
  const visibleStatusTone =
    attachments.error || voiceError || submitError ? "error" : statusTone;
  const trimmedDraft = draft.trim();
  const hasSendableContent = trimmedDraft.length > 0 || attachments.hasImages;
  const submitDisabled =
    disabled || submitting || voice.isRecording || attachments.processing;
  const sendLabel = submitting
    ? t("chat.sending", "Sending…")
    : t("chat.send", "Send");
  const footerMessage = disabled ? disabledReason : visibleStatus;
  const footerTone = disabled ? "neutral" : visibleStatusTone;
  const showVoiceUi = voice.isRecording;

  return (
    <div
      className={`relative shrink-0 pt-1 ${COMPOSER_HORIZONTAL_GUTTER_CLASS} ${COMPOSER_BOTTOM_DOCK_PADDING_CLASS} pb-[max(12px,env(safe-area-inset-bottom))]`}
      data-mobile-composer="true"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-[-24px] bottom-0 bg-gradient-to-t from-chat-container via-chat-container/95 to-transparent"
      />
      {footerMessage && !showVoiceUi ? (
        <div className="relative z-10 px-1 pb-1">
          <span
            className={`chat-block-xs block min-w-0 truncate ${
              footerTone === "error" ? "text-danger-6" : "text-text-3"
            }`}
            role={footerTone === "error" ? "alert" : "status"}
            title={footerMessage}
          >
            {footerMessage}
          </span>
        </div>
      ) : null}
      <ComposerShell
        variant="embedded"
        className="composer-breathing relative z-10"
      >
        {showVoiceUi ? (
          <VoiceRecordingBar
            elapsedSeconds={voice.elapsedSeconds}
            onCancel={voice.cancel}
            onAccept={voice.stop}
          />
        ) : (
          <>
            {attachments.hasImages ? (
              <MobileComposerImagePreview
                images={attachments.images}
                onRemove={attachments.removeImage}
              />
            ) : null}
            <ComposerBarLayout
              toolbarPaddingClassName={MOBILE_COMPOSER_CONTENT_INSET_X_CLASS}
              editorSlot={
                <Textarea
                  value={draft}
                  onChange={(value) => setDraft(value)}
                  placeholder={t("chat.typeMessage", "Type a message…")}
                  autoSize={{ minRows: 1, maxRows: 4 }}
                  rows={1}
                  resize="none"
                  appearance="bare"
                  disabled={disabled}
                  preventMobileFocusZoom
                  className="min-w-0"
                  textareaClassName={`!${MOBILE_COMPOSER_CONTENT_INSET_X_CLASS} !py-1.5`}
                  textareaStyle={{
                    minHeight: MOBILE_COMPOSER_EDITOR_MIN_HEIGHT,
                    maxHeight: INPUT_AREA_EDITOR_HEIGHT.max,
                    paddingLeft: MOBILE_COMPOSER_CONTENT_INSET_PX,
                    paddingRight: MOBILE_COMPOSER_CONTENT_INSET_PX,
                  }}
                />
              }
              leftContent={
                <div className={INPUT_AREA_CONTROL_GROUP_CLASS}>
                  <MobileComposerAttachmentButton
                    disabled={disabled}
                    busy={attachments.processing}
                    onFilesSelected={attachments.ingestFiles}
                  />
                  {modelPicker ? (
                    <MobileModelPicker
                      {...modelPicker}
                      embedded
                      disabled={disabled}
                      patching={modelPicker.patching}
                    />
                  ) : null}
                </div>
              }
              rightContent={
                <div className="flex h-7 items-center gap-0.5">
                  <VoiceInputButton
                    onPressStart={voice.start}
                    onPressEnd={voice.stop}
                    disabled={disabled || !voice.isSupported}
                  />
                  <ComposerSubmitButton
                    active={hasSendableContent && !submitDisabled}
                    disabled={submitDisabled}
                    busy={submitting}
                    ariaLabel={sendLabel}
                    onClick={() => void handleSend()}
                    state={submitting ? "submitting" : "submit"}
                    testId="mobile-composer-send"
                  />
                </div>
              }
            />
          </>
        )}
      </ComposerShell>
    </div>
  );
}

MobileComposer.displayName = "MobileComposer";
