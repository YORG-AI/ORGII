/**
 * QuestionCardShell
 *
 * Complete question card using the composer stack bar pattern
 * (same visual treatment as QueuedMessages and CompactFileChanges).
 *
 * Collapsible via ComposerStackHeader. Body + footer hide when collapsed.
 *
 * Used by AskQuestionCard, AskQuestionPreview, and QuestionBubble.
 */
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import IconButton from "@src/components/IconButton";
import { COMPOSER_CARD_SHELL_CLASSES } from "@src/config/composerStackTokens";
import {
  ArrowDown01Icon,
  ArrowUp01Icon,
  HelpCircleIcon,
  HugeiconsIcon,
} from "@src/icons";

import ComposerStackHeader from "../components/ComposerStackHeader";
import {
  QuestionCardBody,
  type QuestionCardBodyProps,
} from "./QuestionCardBody";
import {
  QuestionCardFooter,
  type QuestionCardFooterProps,
} from "./QuestionCardFooter";

export interface QuestionCardShellProps
  extends QuestionCardBodyProps, QuestionCardFooterProps {
  /** When true, renders nothing — pill shown in row instead. */
  collapsed?: boolean;
  /** Called when the user clicks the collapse chevron. */
  onCollapse?: () => void;
}

export function QuestionCardShell({
  questions,
  selections,
  customTexts,
  onOptionClick,
  onCustomTextChange,
  onCustomOptionFocus,
  registerCustomInput,
  onCustomInputEnter,
  onSkip,
  onSubmit,
  disabled,
  countdownLabel,
  submitLabel,
  skipLabel,
  collapsed = false,
  onCollapse,
}: QuestionCardShellProps) {
  const { t } = useTranslation("sessions");

  const answeredCount = questions.filter((_q, qIdx) => {
    const selected = selections.get(qIdx);
    return selected && selected.size > 0;
  }).length;
  const pendingCount = questions.length - answeredCount;

  const [localExpanded, setLocalExpanded] = useState(true);
  const expanded = collapsed ? false : localExpanded;
  const [focusedQuestion, setFocusedQuestion] = useState(0);
  const questionRefsMap = useRef<Map<number, HTMLDivElement>>(new Map());

  const toggleExpanded = useCallback(() => {
    if (localExpanded && onCollapse) {
      onCollapse();
    } else {
      setLocalExpanded((prev) => !prev);
    }
  }, [localExpanded, onCollapse]);

  const registerQuestionRef = useCallback(
    (qIdx: number, el: HTMLDivElement | null) => {
      if (el) questionRefsMap.current.set(qIdx, el);
      else questionRefsMap.current.delete(qIdx);
    },
    []
  );

  const scrollToQuestion = useCallback((idx: number) => {
    const el = questionRefsMap.current.get(idx);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const handlePrevQuestion = useCallback(() => {
    setFocusedQuestion((prev) => {
      const next = Math.max(0, prev - 1);
      scrollToQuestion(next);
      return next;
    });
  }, [scrollToQuestion]);

  const handleNextQuestion = useCallback(() => {
    setFocusedQuestion((prev) => {
      const next = Math.min(questions.length - 1, prev + 1);
      scrollToQuestion(next);
      return next;
    });
  }, [questions.length, scrollToQuestion]);

  const handleOptionClickWithAutoAdvance = useCallback(
    (qIdx: number, optIdx: number, multiSelect: boolean) => {
      onOptionClick(qIdx, optIdx, multiSelect);
      if (!multiSelect && qIdx < questions.length - 1) {
        setTimeout(() => {
          setFocusedQuestion(qIdx + 1);
          scrollToQuestion(qIdx + 1);
        }, 200);
      }
    },
    [onOptionClick, questions.length, scrollToQuestion]
  );

  if (collapsed) return null;

  return (
    <div className={COMPOSER_CARD_SHELL_CLASSES}>
      <ComposerStackHeader
        icon={
          <HugeiconsIcon
            icon={HelpCircleIcon}
            data-icon="circle-help"
            size={14}
          />
        }
        label={t("chat.questionsPrompt")}
        labelVariant="primary"
        expanded={expanded}
        onToggle={toggleExpanded}
        badges={
          <span className="text-[10px] text-text-3">
            {t("chat.questionProgress", {
              answered: answeredCount,
              pending: pendingCount,
            })}
          </span>
        }
        actions={
          expanded && questions.length > 1 ? (
            <div className="flex items-center gap-0.5">
              <IconButton
                type="button"
                onClick={handlePrevQuestion}
                disabled={focusedQuestion === 0}
              >
                <HugeiconsIcon
                  icon={ArrowUp01Icon}
                  data-icon="chevron-up"
                  size={12}
                />
              </IconButton>
              <span className="min-w-[44px] text-center text-[10px] text-text-1">
                {t("chat.xOfY", {
                  current: focusedQuestion + 1,
                  total: questions.length,
                })}
              </span>
              <IconButton
                type="button"
                onClick={handleNextQuestion}
                disabled={focusedQuestion >= questions.length - 1}
              >
                <HugeiconsIcon
                  icon={ArrowDown01Icon}
                  data-icon="chevron-down"
                  size={12}
                />
              </IconButton>
            </div>
          ) : undefined
        }
      />

      {expanded && (
        <>
          <QuestionCardBody
            questions={questions}
            selections={selections}
            customTexts={customTexts}
            onOptionClick={handleOptionClickWithAutoAdvance}
            onCustomTextChange={onCustomTextChange}
            onCustomOptionFocus={onCustomOptionFocus}
            registerCustomInput={registerCustomInput}
            onCustomInputEnter={onCustomInputEnter}
            registerQuestionRef={registerQuestionRef}
          />

          <QuestionCardFooter
            onSkip={onSkip}
            onSubmit={onSubmit}
            disabled={disabled}
            countdownLabel={countdownLabel}
            submitLabel={submitLabel}
            skipLabel={skipLabel}
          />
        </>
      )}
    </div>
  );
}

QuestionCardShell.displayName = "QuestionCardShell";
