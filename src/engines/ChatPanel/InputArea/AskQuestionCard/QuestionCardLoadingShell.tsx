/**
 * QuestionCardLoadingShell
 *
 * Header-only placeholder shown above the composer while an
 * `ask_user_questions` tool call is in-flight but its `args.questions`
 * payload hasn't streamed far enough to render the real QuestionCardShell
 * yet. Uses the same outer card frame so swapping to the live card on
 * stream-complete is visually seamless.
 *
 * Mirrors the `EventBlockHeaderTitle isLoading` shimmer treatment used by
 * the history-side `AskQuestionEvent` placeholder.
 */
import { useTranslation } from "react-i18next";

import { COMPOSER_CARD_SHELL_CLASSES } from "@src/config/composerStackTokens";
import { EVENT_LOADING_SHIMMER_TEXT_CLASSES } from "@src/engines/ChatPanel/blocks/primitives";
import { HelpCircleIcon, HugeiconsIcon } from "@src/icons";

export function QuestionCardLoadingShell() {
  const { t } = useTranslation("sessions");
  return (
    <div className={COMPOSER_CARD_SHELL_CLASSES}>
      <div className="flex h-8 items-center gap-1.5 px-2.5">
        <div className="flex h-[14px] w-[14px] shrink-0 items-center justify-center text-primary-6">
          <HugeiconsIcon
            icon={HelpCircleIcon}
            data-icon="circle-help"
            size={14}
          />
        </div>
        <span
          className={`min-w-0 truncate text-[13px] font-bold ${EVENT_LOADING_SHIMMER_TEXT_CLASSES}`}
        >
          {t("chat.generatingQuestions")}
        </span>
      </div>
    </div>
  );
}

QuestionCardLoadingShell.displayName = "QuestionCardLoadingShell";
