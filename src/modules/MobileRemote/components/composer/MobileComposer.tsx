import React, { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import ComposerBarLayout from "@src/components/ComposerBar/ComposerBarLayout";
import ComposerSubmitButton from "@src/components/ComposerBar/ComposerSubmitButton";
import ComposerShell from "@src/components/ComposerShell";
import Textarea from "@src/components/Textarea";
import {
  COMPOSER_BOTTOM_DOCK_PADDING_CLASS,
  COMPOSER_HORIZONTAL_GUTTER_CLASS,
} from "@src/config/composerStackTokens";
import { INPUT_AREA_EDITOR_HEIGHT } from "@src/config/inputAreaTokens";

const MOBILE_COMPOSER_EDITOR_MIN_HEIGHT = 36;

export interface MobileComposerProps {
  disabled?: boolean;
  disabledReason?: string;
  statusMessage?: string;
  statusTone?: "neutral" | "error";
  onSend?: (content: string) => void | Promise<void>;
}

export function MobileComposer({
  disabled = false,
  disabledReason,
  statusMessage,
  statusTone = "neutral",
  onSend,
}: MobileComposerProps) {
  const { t } = useTranslation("sessions");
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string>();

  const handleSend = useCallback(async () => {
    if (disabled || submitting) return;
    const trimmed = draft.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setSubmitError(undefined);
    try {
      await onSend?.(trimmed);
      setDraft((current) => (current === draft ? "" : current));
    } catch (error) {
      setSubmitError(
        error instanceof Error
          ? error.message
          : t("chat.sendFailed", "Message could not be sent")
      );
    } finally {
      setSubmitting(false);
    }
  }, [disabled, draft, onSend, submitting, t]);

  const visibleStatus = submitError ?? statusMessage;
  const visibleStatusTone = submitError ? "error" : statusTone;
  const trimmedDraft = draft.trim();
  const submitDisabled = disabled || submitting;
  const sendLabel = submitting
    ? t("chat.sending", "Sending…")
    : t("chat.send", "Send");
  const footerMessage = disabled ? disabledReason : visibleStatus;
  const footerTone = disabled ? "neutral" : visibleStatusTone;

  return (
    <div
      className={`relative shrink-0 pt-1 ${COMPOSER_HORIZONTAL_GUTTER_CLASS} ${COMPOSER_BOTTOM_DOCK_PADDING_CLASS} pb-[max(12px,env(safe-area-inset-bottom))]`}
      data-mobile-composer="true"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-[-24px] bottom-0 bg-gradient-to-t from-chat-container via-chat-container/95 to-transparent"
      />
      <ComposerShell
        variant="embedded"
        className="composer-breathing relative z-10"
      >
        <ComposerBarLayout
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
              textareaClassName="!px-2 !py-1.5"
              textareaStyle={{
                minHeight: MOBILE_COMPOSER_EDITOR_MIN_HEIGHT,
                maxHeight: INPUT_AREA_EDITOR_HEIGHT.max,
              }}
            />
          }
          leftContent={
            footerMessage ? (
              <span
                className={`chat-block-xs min-w-0 truncate px-1 ${
                  footerTone === "error" ? "text-danger-6" : "text-text-3"
                }`}
                role={footerTone === "error" ? "alert" : "status"}
                title={footerMessage}
              >
                {footerMessage}
              </span>
            ) : null
          }
          rightContent={
            <ComposerSubmitButton
              active={trimmedDraft.length > 0 && !submitDisabled}
              disabled={submitDisabled}
              busy={submitting}
              ariaLabel={sendLabel}
              onClick={() => void handleSend()}
              state={submitting ? "submitting" : "submit"}
              testId="mobile-composer-send"
            />
          }
        />
      </ComposerShell>
    </div>
  );
}

MobileComposer.displayName = "MobileComposer";
