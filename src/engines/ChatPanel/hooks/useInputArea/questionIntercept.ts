/**
 * Question intercept for the main composer.
 *
 * When the agent asked a question (AskQuestionCard pending) and the user
 * types into the main input instead of the card, the send finalizes the
 * pending batch: free-text questions receive the typed text as the answer,
 * option-based questions are skipped.
 *
 * The native commands (`agent_question_response` / `agent_question_reject`)
 * have no CLI bridge — for managed CLI sessions they always fail with
 * "No session found…" and no `agent:interaction_finalized` can ever arrive
 * (there is no QuestionManager). The event store fallback below is therefore
 * the ONLY closer on that path; without it the card lingers forever. Same
 * resilience contract as the card's own click path (useQuestionSubmission).
 */
import { rejectQuestion, respondQuestion } from "@src/api/tauri/agent";
import { extractQuestionBatch } from "@src/engines/ChatPanel/InputArea/AskQuestionCard/extractQuestionBatch";
import { markQuestionAnswered } from "@src/engines/ChatPanel/InputArea/AskQuestionCard/questionSubmitUtils";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { createLogger } from "@src/hooks/logger";

const log = createLogger("questionIntercept");

export function interceptPendingQuestionBatches(
  events: SessionEvent[],
  sessionId: string,
  typedText: string,
  skippedLabel: string
): void {
  for (const event of events) {
    if (event.sessionId && event.sessionId !== sessionId) continue;
    const batch = extractQuestionBatch(event);
    if (!batch) continue;
    const isFreeText = batch.questions.every(
      (question) => question.options.length === 0
    );
    if (isFreeText) {
      void respondQuestion(batch.sessionId, batch.questionId, [[typedText]])
        .then(() =>
          markQuestionAnswered(batch.sessionId, batch.chunkId, [[typedText]])
        )
        .catch((err: unknown) => {
          log.warn("[questionIntercept] respondQuestion failed:", err);
          void markQuestionAnswered(batch.sessionId, batch.chunkId, [
            [typedText],
          ]);
        });
    } else {
      void rejectQuestion(batch.sessionId, batch.questionId)
        .then(() =>
          markQuestionAnswered(
            batch.sessionId,
            batch.chunkId,
            [[skippedLabel]],
            "rejected"
          )
        )
        .catch((err: unknown) => {
          log.warn("[questionIntercept] rejectQuestion failed:", err);
          void markQuestionAnswered(
            batch.sessionId,
            batch.chunkId,
            [[skippedLabel]],
            "rejected"
          );
        });
    }
  }
}
