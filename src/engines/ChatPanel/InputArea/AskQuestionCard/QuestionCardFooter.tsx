/**
 * QuestionCardFooter
 *
 * Shared footer bar for question/action cards: left slot (empty or extra content)
 * + right slot with Skip and Submit buttons.
 *
 * Used by AskQuestionCard (live session), QuestionBubble (session replay),
 * and AskQuestionPreview (DevTools).
 */
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import type { ButtonProps } from "@src/components/Button";

import {
  ASK_QUESTION_CARD_FOOTER,
  ASK_QUESTION_CARD_FOOTER_LEFT,
  ASK_QUESTION_CARD_FOOTER_RIGHT,
} from "./askQuestionCardClassNames";

export interface QuestionCardFooterProps {
  onSkip?: () => void;
  onSubmit?: () => void;
  disabled?: boolean;
  /** Optional countdown label shown before the Skip button (e.g. auto-skip timer) */
  countdownLabel?: string;
  submitLabel?: string;
  skipLabel?: string;
  submitButtonVariant?: ButtonProps["variant"];
  answeredCount?: number;
  pendingCount?: number;
}

export function QuestionCardFooter({
  onSkip,
  onSubmit,
  disabled = false,
  countdownLabel,
  submitLabel,
  skipLabel,
  submitButtonVariant = "primary",
  answeredCount,
  pendingCount,
}: QuestionCardFooterProps) {
  const { t } = useTranslation("sessions");

  return (
    <div className={ASK_QUESTION_CARD_FOOTER}>
      <div className={ASK_QUESTION_CARD_FOOTER_LEFT}>
        {answeredCount !== undefined && pendingCount !== undefined && (
          <span className="chat-block-xs text-text-3">
            {t("chat.questionProgress", {
              answered: answeredCount,
              pending: pendingCount,
            })}
          </span>
        )}
      </div>
      <div className={ASK_QUESTION_CARD_FOOTER_RIGHT}>
        {countdownLabel && (
          <span className="chat-block-xs text-text-3 tabular-nums">
            {countdownLabel}
          </span>
        )}
        <Button
          variant="tertiary"
          size="mini"
          onClick={onSkip}
          disabled={disabled}
        >
          {skipLabel ?? t("chat.skip")}
        </Button>
        <Button
          variant={submitButtonVariant}
          size="mini"
          onClick={onSubmit}
          disabled={disabled}
        >
          {submitLabel ?? t("common:actions.submit")}
        </Button>
      </div>
    </div>
  );
}

QuestionCardFooter.displayName = "QuestionCardFooter";
