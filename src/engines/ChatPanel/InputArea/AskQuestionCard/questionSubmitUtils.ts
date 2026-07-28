/**
 * Shared pure functions for question answer submission.
 *
 * Used by both AskQuestionCard (chat panel) and QuestionBubble (simulator)
 * to ensure consistent answer building, validation, and event store updates.
 */
import {
  CUSTOM_OPTION_INDEX,
  type SingleQuestion,
} from "@src/engines/ChatPanel/InputArea/AskQuestionCard/types";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import type { EventDisplayStatus } from "@src/engines/SessionCore/core/types";

/**
 * Build answer IDs from user selections (sent to backend).
 * Uses option.id for structured options, raw text for custom input.
 */
export function buildAnswerIds(
  questions: SingleQuestion[],
  selections: Map<number, Set<number>>,
  customTexts: Map<number, string>
): string[][] {
  return questions.map((question, qIdx) => {
    if (question.options.length === 0) return ["acknowledged"];
    const selected = selections.get(qIdx);
    if (!selected || selected.size === 0) return [];

    const ids = Array.from(selected)
      .filter((idx) => idx !== CUSTOM_OPTION_INDEX)
      .sort()
      .map((optIdx) => question.options[optIdx]?.id ?? "")
      .filter(Boolean);

    if (selected.has(CUSTOM_OPTION_INDEX)) {
      const text = customTexts.get(qIdx)?.trim();
      if (text) ids.push(text);
    }

    return ids;
  });
}

/**
 * Build human-readable answer labels from user selections (for display in history).
 * Uses option.label (+ description) instead of IDs.
 */
export function buildAnswerLabels(
  questions: SingleQuestion[],
  selections: Map<number, Set<number>>,
  customTexts: Map<number, string>
): string[][] {
  return questions.map((question, qIdx) => {
    if (question.options.length === 0) return ["Acknowledged"];
    const selected = selections.get(qIdx);
    if (!selected || selected.size === 0) return [];

    const labels = Array.from(selected)
      .filter((idx) => idx !== CUSTOM_OPTION_INDEX)
      .sort()
      .map((optIdx) => {
        const opt = question.options[optIdx];
        if (!opt) return "";
        return opt.description
          ? `${opt.label} — ${opt.description}`
          : opt.label;
      })
      .filter(Boolean);

    if (selected.has(CUSTOM_OPTION_INDEX)) {
      const text = customTexts.get(qIdx)?.trim() ?? "";
      if (text) labels.push(text);
    }

    return labels;
  });
}

/**
 * Validate all questions with options have at least one answer selected.
 */
export function validateAnswers(
  questions: SingleQuestion[],
  answers: string[][],
  selections: Map<number, Set<number>>,
  customTexts: Map<number, string>
): { valid: boolean; hasEmptyCustom: boolean } {
  const unanswered = questions.some(
    (question, qIdx) =>
      question.options.length > 0 && answers[qIdx].length === 0
  );
  if (!unanswered) return { valid: true, hasEmptyCustom: false };

  const hasEmptyCustom = questions.some((_question, qIdx) => {
    const selected = selections.get(qIdx);
    return selected?.has(CUSTOM_OPTION_INDEX) && !customTexts.get(qIdx)?.trim();
  });

  return { valid: false, hasEmptyCustom };
}

/**
 * Finalize a question event in the frontend store as soon as the response API
 * succeeds. Rust's `agent:interaction_finalized` remains the authoritative,
 * idempotent confirmation, but the visible card must not stay in
 * `awaiting_user` while that broadcast travels through the event pipeline.
 *
 * `status` distinguishes "user answered" (default) from "user dismissed via
 * Skip" ("rejected"). The history card renders the two differently.
 */
export async function markQuestionAnswered(
  sessionId: string,
  chunkId: string,
  answerLabels: string[][],
  status: "answered" | "rejected" = "answered"
): Promise<boolean> {
  if (!chunkId) return false;

  const events = await eventStoreProxy.getEvents(sessionId);
  const evt = events.find((event) => event.id === chunkId);
  if (!evt) return false;

  await eventStoreProxy.upsert(
    {
      ...evt,
      result: {
        ...(evt.result as Record<string, unknown>),
        answers: answerLabels,
        status,
      },
      displayStatus: "completed" as EventDisplayStatus,
      activityStatus: "processed",
    },
    sessionId
  );
  return true;
}
