import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import {
  extractQuestionBatch,
  isAskUserQuestionsEvent,
} from "./extractQuestionBatch";
import type { QuestionBatch } from "./types";

export interface QuestionSignals {
  batches: QuestionBatch[];
  streamingCount: number;
}

export function extractQuestionSignals(
  events: ReadonlyArray<SessionEvent>
): QuestionSignals {
  const batches: QuestionBatch[] = [];
  const seenIds = new Set<string>();
  let streamingCount = 0;

  for (const event of events) {
    const batch = extractQuestionBatch(event);
    if (batch) {
      if (batch.questionId && seenIds.has(batch.questionId)) continue;
      if (batch.questionId) seenIds.add(batch.questionId);
      batches.push(batch);
      continue;
    }

    if (!isAskUserQuestionsEvent(event)) continue;
    const status = event.displayStatus;
    if (
      status !== "running" &&
      status !== "pending" &&
      status !== "awaiting_user"
    ) {
      continue;
    }
    const result = event.result as Record<string, unknown> | undefined;
    if (result && Object.keys(result).length > 0) continue;
    streamingCount += 1;
  }

  return { batches, streamingCount };
}

function questionBatchEqual(
  left: QuestionBatch,
  right: QuestionBatch
): boolean {
  if (
    left.questionId !== right.questionId ||
    left.chunkId !== right.chunkId ||
    left.sessionId !== right.sessionId ||
    left.blocking !== right.blocking ||
    left.autoResolveAt !== right.autoResolveAt ||
    left.questions.length !== right.questions.length
  ) {
    return false;
  }
  for (let index = 0; index < left.questions.length; index += 1) {
    const leftQuestion = left.questions[index];
    const rightQuestion = right.questions[index];
    if (
      leftQuestion.text !== rightQuestion.text ||
      leftQuestion.multiSelect !== rightQuestion.multiSelect ||
      leftQuestion.options.length !== rightQuestion.options.length
    ) {
      return false;
    }
    for (
      let optionIndex = 0;
      optionIndex < leftQuestion.options.length;
      optionIndex += 1
    ) {
      const leftOption = leftQuestion.options[optionIndex];
      const rightOption = rightQuestion.options[optionIndex];
      if (
        leftOption.id !== rightOption.id ||
        leftOption.label !== rightOption.label ||
        leftOption.description !== rightOption.description
      ) {
        return false;
      }
    }
  }
  return true;
}

export function questionSignalsEqual(
  left: QuestionSignals,
  right: QuestionSignals
): boolean {
  if (left.streamingCount !== right.streamingCount) return false;
  if (left.batches.length !== right.batches.length) return false;
  return left.batches.every((batch, index) =>
    questionBatchEqual(batch, right.batches[index])
  );
}
