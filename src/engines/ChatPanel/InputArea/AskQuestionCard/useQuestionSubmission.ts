/**
 * useQuestionSubmission Hook
 *
 * Single source of truth for submitting/skipping question answers.
 * Handles the full flow: validation → backend call → event store mark.
 *
 * Used by both AskQuestionCard (chat panel) and QuestionBubble (simulator).
 * Components only need to manage UI state (selections, navigation) and
 * call submitAnswers / skipQuestion — all backend + store logic lives here.
 */
import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { rejectQuestion, respondQuestion } from "@src/api/tauri/agent";
import Message from "@src/components/Message";
import type { SingleQuestion } from "@src/engines/ChatPanel/InputArea/AskQuestionCard/types";

import {
  buildAnswerIds,
  buildAnswerLabels,
  markQuestionAnswered,
  validateAnswers,
} from "./questionSubmitUtils";

export interface QuestionSubmitInput {
  sessionId: string;
  questionId: string;
  chunkId: string;
  questions: SingleQuestion[];
  selections: Map<number, Set<number>>;
  customTexts: Map<number, string>;
}

export interface UseQuestionSubmissionReturn {
  submitAnswers: (input: QuestionSubmitInput) => Promise<boolean>;
  skipQuestion: (
    input: Pick<QuestionSubmitInput, "sessionId" | "questionId" | "chunkId">
  ) => Promise<boolean>;
  isSubmitting: boolean;
}

export function useQuestionSubmission(): UseQuestionSubmissionReturn {
  const { t } = useTranslation("sessions");

  const submitAnswers = useCallback(
    async (input: QuestionSubmitInput): Promise<boolean> => {
      const {
        sessionId,
        questionId,
        chunkId,
        questions,
        selections,
        customTexts,
      } = input;

      const answers = buildAnswerIds(questions, selections, customTexts);
      const { valid, hasEmptyCustom } = validateAnswers(
        questions,
        answers,
        selections,
        customTexts
      );

      if (!valid) {
        Message.warning(
          hasEmptyCustom
            ? t("chat.pleaseTypeAnswer")
            : t("chat.pleaseSelectOption")
        );
        return false;
      }

      try {
        // Rust `QuestionManager::respond` broadcasts `agent:interaction_finalized`
        // which flips the event to `status: "answered"` in the store. The FE
        // also writes the same overlay synchronously so the card flips even if
        // the finalize event is dropped (e.g. tool_call_id mismatch, channel
        // buffer eviction) — the broadcast then becomes an idempotent confirm.
        await respondQuestion(sessionId, questionId, answers);
        await markQuestionAnswered(
          sessionId,
          chunkId,
          buildAnswerLabels(questions, selections, customTexts)
        );
        Message.success(t("chat.answerSubmitted"));
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isExpired =
          msg.includes("No question manager") ||
          msg.includes("No pending question") ||
          msg.includes("No session found for question response") ||
          msg.includes("No pending question found for request/tool_call");
        if (isExpired) {
          Message.warning(t("chat.questionExpired"));
          // Backend has nothing to finalize, so we flip the event ourselves.
          // The user DID answer — expired only means the pending request was
          // already gone (session restart, etc.). Use their real selections,
          // not a "skipped" placeholder.
          await markQuestionAnswered(
            sessionId,
            chunkId,
            buildAnswerLabels(questions, selections, customTexts)
          );
          return true;
        }
        Message.error(t("chat.failedToSubmit", { msg }));
        return false;
      }
    },
    [t]
  );

  const skipQuestion = useCallback(
    async (
      input: Pick<QuestionSubmitInput, "sessionId" | "questionId" | "chunkId">
    ): Promise<boolean> => {
      const { sessionId, questionId, chunkId } = input;
      const skippedLabel = t("chat.skippedByUser");

      try {
        // Rust emits `agent:interaction_finalized` with status=rejected. Keep
        // the same immediate frontend completion as the answer path so Skip
        // cannot remain visually stuck if that broadcast is delayed.
        await rejectQuestion(sessionId, questionId);
        await markQuestionAnswered(
          sessionId,
          chunkId,
          [[skippedLabel]],
          "rejected"
        );
        return true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isExpired =
          msg.includes("No question manager") ||
          msg.includes("No pending question") ||
          msg.includes("No session found for question response") ||
          msg.includes("No pending question found for request/tool_call");
        if (isExpired) {
          Message.warning(t("chat.questionExpired"));
        }
        await markQuestionAnswered(
          sessionId,
          chunkId,
          [[skippedLabel]],
          "rejected"
        );
        return true;
      }
    },
    [t]
  );

  return { submitAnswers, skipQuestion, isSubmitting: false };
}
