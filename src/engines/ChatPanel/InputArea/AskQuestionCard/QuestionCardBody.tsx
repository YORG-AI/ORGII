/**
 * QuestionCardBody
 *
 * Pure presentational component: renders all questions in the card —
 * question text, lettered options, custom-answer input.
 *
 * Shared by AskQuestionCard (live session) and AskQuestionPreview (DevTools).
 * All interaction state is passed in via props so each consumer can wire its
 * own submission / selection logic.
 */
import { useTranslation } from "react-i18next";

import Textarea from "@src/components/Textarea";
import { HugeiconsIcon, PenLineIcon } from "@src/icons";
import { classNames } from "@src/util/ui/classNames";

import { QuestionRow } from "./QuestionRow";
import {
  ASK_QUESTION_CARD_CONTENT,
  ASK_QUESTION_CARD_OPTIONS,
  ASK_QUESTION_CARD_OPTION_BASE,
  ASK_QUESTION_CARD_OPTION_SELECTED,
  ASK_QUESTION_CARD_OPTION_TEXT,
  ASK_QUESTION_CARD_OPTION_TEXT_MUTED,
  ASK_QUESTION_CARD_QUESTION_TEXT,
} from "./askQuestionCardClassNames";
import {
  CUSTOM_OPTION_INDEX,
  OPTION_LABELS,
  type SingleQuestion,
} from "./types";

export interface QuestionCardBodyProps {
  questions: SingleQuestion[];
  selections: Map<number, Set<number>>;
  customTexts: Map<number, string>;
  onOptionClick: (qIdx: number, optIdx: number, multiSelect: boolean) => void;
  onCustomTextChange: (qIdx: number, value: string) => void;
  onCustomOptionFocus: (qIdx: number) => void;
  registerCustomInput: (
    qIdx: number
  ) => (el: HTMLTextAreaElement | null) => void;
  onCustomInputEnter?: () => void;
  registerQuestionRef?: (qIdx: number, el: HTMLDivElement | null) => void;
}

export function QuestionCardBody({
  questions,
  selections,
  customTexts,
  onOptionClick,
  onCustomTextChange,
  onCustomOptionFocus,
  registerCustomInput,
  onCustomInputEnter,
  registerQuestionRef,
}: QuestionCardBodyProps) {
  const { t } = useTranslation("sessions");

  return (
    <div className={ASK_QUESTION_CARD_CONTENT}>
      <div className="flex min-h-0 flex-col gap-3">
        {questions.map((question, qIdx) => {
          const currentSelected = selections.get(qIdx) ?? new Set<number>();
          const isCustomSelected = currentSelected.has(CUSTOM_OPTION_INDEX);

          return (
            <div
              key={qIdx}
              ref={(el) => registerQuestionRef?.(qIdx, el)}
              className="flex flex-col gap-0.5"
            >
              <QuestionRow
                number={qIdx + 1}
                textClassName={ASK_QUESTION_CARD_QUESTION_TEXT}
              >
                {question.text}
                {question.multiSelect && (
                  <span className="ml-1.5 text-primary-6">
                    {t("chat.multipleChoice")}
                  </span>
                )}
              </QuestionRow>

              {question.options.length > 0 && (
                <div className={ASK_QUESTION_CARD_OPTIONS}>
                  {question.options.map((option, optIdx) => {
                    const isSelected = currentSelected.has(optIdx);
                    const letter = OPTION_LABELS[optIdx] || String(optIdx + 1);

                    return (
                      <button
                        key={optIdx}
                        type="button"
                        onClick={() =>
                          onOptionClick(qIdx, optIdx, question.multiSelect)
                        }
                        className={classNames(
                          ASK_QUESTION_CARD_OPTION_BASE,
                          isSelected && ASK_QUESTION_CARD_OPTION_SELECTED
                        )}
                      >
                        <span
                          className={classNames(
                            "chat-block-xs flex h-[22px] w-[22px] shrink-0 items-center justify-center font-semibold transition-all duration-150 ease-in-out",
                            question.multiSelect ? "rounded" : "rounded-full",
                            isSelected
                              ? "bg-primary-6 text-bg-1"
                              : "bg-bg-2 text-primary-6"
                          )}
                        >
                          {letter}
                        </span>
                        <span
                          className={classNames(
                            ASK_QUESTION_CARD_OPTION_TEXT,
                            option.label.toLowerCase().includes("other") &&
                              ASK_QUESTION_CARD_OPTION_TEXT_MUTED
                          )}
                        >
                          {option.description
                            ? `${option.label} — ${option.description}`
                            : option.label}
                        </span>
                      </button>
                    );
                  })}

                  <div
                    className={classNames(
                      ASK_QUESTION_CARD_OPTION_BASE,
                      "flex-col items-stretch!",
                      isCustomSelected && ASK_QUESTION_CARD_OPTION_SELECTED
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        onOptionClick(
                          qIdx,
                          CUSTOM_OPTION_INDEX,
                          question.multiSelect
                        );
                        onCustomOptionFocus(qIdx);
                      }}
                      className="flex w-full items-center gap-2.5 border-none bg-transparent p-0 text-left"
                    >
                      <span
                        className={classNames(
                          "flex h-[22px] w-[22px] shrink-0 items-center justify-center transition-all duration-150 ease-in-out",
                          question.multiSelect ? "rounded" : "rounded-full",
                          isCustomSelected
                            ? "bg-primary-6 text-bg-1"
                            : "bg-bg-2 text-primary-6"
                        )}
                      >
                        <HugeiconsIcon
                          icon={PenLineIcon}
                          data-icon="pen-line"
                          size={12}
                        />
                      </span>
                      <span
                        className={classNames(
                          ASK_QUESTION_CARD_OPTION_TEXT,
                          ASK_QUESTION_CARD_OPTION_TEXT_MUTED
                        )}
                      >
                        {t("chat.describeItYourself")}
                      </span>
                    </button>
                    {isCustomSelected && (
                      <Textarea
                        ref={registerCustomInput(qIdx)}
                        size="small"
                        autoSize={{ minRows: 1, maxRows: 4 }}
                        resize="none"
                        placeholder={t("chat.typeYourAnswer")}
                        value={customTexts.get(qIdx) ?? ""}
                        onChange={(val) => onCustomTextChange(qIdx, val)}
                        className="mt-1"
                        onKeyDown={
                          onCustomInputEnter
                            ? (event) => {
                                if (event.key === "Enter" && !event.shiftKey) {
                                  event.preventDefault();
                                  onCustomInputEnter();
                                }
                              }
                            : undefined
                        }
                      />
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {questions.length > 1 && <div className="min-h-[100px] shrink-0" />}
      </div>
    </div>
  );
}

QuestionCardBody.displayName = "QuestionCardBody";
