/**
 * AskQuestionEvent - Universal Component
 *
 * Renders agent clarification questions in the chat history.
 *
 * Two states:
 * - Pending: Interactive question with options (rarely shown here since
 *   AskQuestionCard above the input handles active questions)
 * - Answered: "Answers" card showing question + selected answer
 *
 * @example
 * <AskQuestionEvent event={event} />
 */
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { getEventIcon } from "@src/config/toolIcons";
import { QuestionRow } from "@src/engines/ChatPanel/InputArea/AskQuestionCard/QuestionRow";
import {
  ASK_QUESTION_EVENT_ANSWER_TEXT,
  ASK_QUESTION_EVENT_QUESTION_BODY,
} from "@src/engines/ChatPanel/InputArea/AskQuestionCard/askQuestionCardClassNames";
import {
  EventBlockHeader,
  EventBlockHeaderIcon,
  EventBlockHeaderTitle,
  getEventBlockContainerClasses,
} from "@src/engines/ChatPanel/blocks/primitives";
import { useBlockHeader } from "@src/engines/ChatPanel/blocks/useBlockLocate";
import {
  type RawEventInput,
  useNormalizedEventProps,
} from "@src/engines/SessionCore/rendering/props";
import {
  useLifecycleLabels,
  useToolLabelText,
} from "@src/engines/SessionCore/rendering/registry";
import type { EventVariant } from "@src/engines/SessionCore/rendering/types/universalProps";

import { AskQuestionHistoryBody } from "./AskQuestionHistoryChrome";

// ============================================
// Types
// ============================================

interface AskQuestionEventProps extends RawEventInput {
  variant?: EventVariant;
}

interface StructuredQuestionOption {
  label: string;
  description?: string;
  id?: string;
}

interface StructuredQuestion {
  question?: string;
  prompt?: string;
  header?: string;
  title?: string;
  text?: string;
  content?: string;
  options?: StructuredQuestionOption[];
  multiSelect?: boolean;
  allow_multiple?: boolean;
  id?: string;
}

interface AnsweredPair {
  question: string;
  answers: string[];
}

// ============================================
// Extract answered data from event
// ============================================

// Parse the LLM-facing prose blob written by Rust `format_answers_for_llm`
// (see `src-tauri/crates/agent-core/src/core/interaction/question.rs:304`).
// Format:
//   `User has answered your questions: "Q1" = "A1", "Q2" = "A2". You can ...`
//
// We use the known question texts (from `args.questions`) as left/right
// anchors, which is robust against answer text containing `", "`, commas,
// multi-select joined answers, or the literal `Unanswered` placeholder.
//
// Returns an array aligned to `questionTexts.length`; positions that could
// not be located are filled with an empty array so downstream `[idx]` lookup
// stays stable.
export function parseAnswersFromContent(
  resultContent: string,
  questionTexts: string[]
): string[][] {
  const prefix = "User has answered your questions: ";
  if (!resultContent.startsWith(prefix)) {
    return questionTexts.map(() => []);
  }
  const trailing = ". You can now continue";
  let body = resultContent.slice(prefix.length);
  const trailIdx = body.indexOf(trailing);
  if (trailIdx >= 0) body = body.slice(0, trailIdx);

  // Locate each `"Qi" = "` opener by question text.
  const openers: { idx: number; afterEq: number }[] = questionTexts.map((q) => {
    if (!q) return { idx: -1, afterEq: -1 };
    const opener = `"${q}" = "`;
    const idx = body.indexOf(opener);
    return idx < 0
      ? { idx: -1, afterEq: -1 }
      : { idx, afterEq: idx + opener.length };
  });

  return questionTexts.map((_q, i) => {
    const cur = openers[i];
    if (cur.idx < 0) return [];
    // Find the next opener that comes after the current one to bound the
    // answer; if none, the answer runs to the end of body (minus trailing `"`).
    let nextStart = body.length;
    for (let j = 0; j < openers.length; j++) {
      const next = openers[j];
      if (j === i || next.idx < 0) continue;
      if (next.idx > cur.idx && next.idx < nextStart) {
        // The separator before `"Qj" = "` is `, ` — back up 2 chars to drop it.
        nextStart = next.idx - 2;
      }
    }
    let raw = body.slice(cur.afterEq, nextStart);
    // Strip the trailing `"` that closes the answer.
    if (raw.endsWith('"')) raw = raw.slice(0, -1);
    // Rust writes the literal "Unanswered" placeholder when answers are empty.
    // Kept in sync with `format_answers_for_llm` in
    // `src-tauri/crates/agent-core/src/core/interaction/question.rs:313`.
    if (raw === "Unanswered") return [];
    return [raw];
  });
}

export function extractAnsweredData(props: RawEventInput): {
  pairs: AnsweredPair[];
  isAnswered: boolean;
  isRejected: boolean;
} {
  const event = props.event;
  const result = (event?.result || props.result) as
    | Record<string, unknown>
    | undefined;
  const args = (event?.args || props.args) as
    | Record<string, unknown>
    | undefined;

  const isRejected = result?.status === "rejected";

  // "answered" requires an explicit signal from the backend: either the
  // result status field is set to "answered"/"responsed", or the agent
  // actually wrote answer payloads. eventStatus === "completed" alone is
  // NOT sufficient — the event completes whenever the tool call finishes,
  // including when the agent proceeds without a user response.
  const hasAnswerPayload =
    (Array.isArray(result?.answers) &&
      (result.answers as unknown[]).length > 0) ||
    (typeof result?.answer === "string" && result.answer.length > 0);

  // Fallback signal: Rust's `question::format_answers_for_llm` emits a
  // stable "User has answered your questions: ..." prefix on the LLM-facing
  // content. When `result.answers`/`result.status` get clobbered by a
  // subsequent generic `agent:tool_result` merge (Object → String fallback
  // in `EventStore::merge_events_with_hydration`), this prefix is the only
  // surviving evidence the user actually responded. Match it so the history
  // card doesn't downgrade a real answer to "Questions skipped".
  const resultContent =
    (typeof result?.content === "string" ? result.content : "") ||
    (typeof result?.observation === "string" ? result.observation : "");
  const contentSignalsAnswered = resultContent.startsWith(
    "User has answered your questions"
  );

  const isAnswered =
    !isRejected &&
    (result?.status === "answered" ||
      result?.status === "responsed" ||
      hasAnswerPayload ||
      contentSignalsAnswered);

  // Try to extract structured questions from args
  const structuredQuestions = args?.questions as
    | StructuredQuestion[]
    | undefined;

  // Answers live on `result.answers` — written authoritatively by Rust
  // `QuestionManager::respond` via `agent:interaction_finalized`. The
  // object-merge in `merge_events` keeps the field across subsequent
  // `agent:tool_result` events.
  const resultAnswers = result?.answers as string[][] | undefined;
  const resultAnswer = result?.answer as string | undefined;

  if (Array.isArray(structuredQuestions) && structuredQuestions.length > 0) {
    const topLevelText =
      (args?.title as string) || (args?.prompt as string) || "";

    const questionTexts = structuredQuestions.map(
      (sq, idx) =>
        sq.question ||
        sq.prompt ||
        sq.header ||
        sq.title ||
        sq.text ||
        sq.content ||
        (idx === 0 ? topLevelText : "")
    );

    // When the structured `answers` field was clobbered by the Rust merge
    // fallback, parse them out of the LLM-facing content using question
    // texts as left anchors. The parsed array is aligned to questions.length.
    const parsedContentAnswers =
      contentSignalsAnswered && !resultAnswers
        ? parseAnswersFromContent(resultContent, questionTexts)
        : undefined;

    const effectiveAnswers = resultAnswers ?? parsedContentAnswers;

    const pairs: AnsweredPair[] = structuredQuestions.map((sq, idx) => {
      let answers: string[] = [];
      if (Array.isArray(effectiveAnswers) && effectiveAnswers[idx]) {
        answers = effectiveAnswers[idx];
      } else if (idx === 0 && resultAnswer) {
        answers = [resultAnswer];
      }

      return {
        question: questionTexts[idx],
        answers,
      };
    });

    return { pairs, isAnswered, isRejected };
  }

  // Legacy single question format
  const questionData = result?.question as Record<string, unknown> | undefined;
  const question =
    (questionData?.question as string) ||
    (typeof result?.question === "string" ? result.question : "") ||
    (result?.content as string) ||
    "";

  const answer = resultAnswer || (questionData?.answer as string) || "";

  if (!question) return { pairs: [], isAnswered, isRejected };

  return {
    pairs: [{ question, answers: answer ? [answer] : [] }],
    isAnswered,
    isRejected,
  };
}

// ============================================
// QuestionHistoryBlock — unified answered / pending / failed display
// ============================================

type QuestionDisplayStatus = "answered" | "pending" | "failed";

function resolveDisplayStatus(
  rawStatus: string | undefined,
  isAnswered: boolean,
  isRejected: boolean,
  resultContentStartsWithError: boolean
): QuestionDisplayStatus {
  // User-dismissed via Skip button: Rust finalize sets `result.status =
  // "rejected"`, FE optimistic overlay does the same. Always render as the
  // terminal "Questions skipped" state — don't paint as answered/pending.
  if (isRejected) return "failed";
  if (isAnswered) return "answered";
  // Tool call completed with a genuine execution error (e.g. LLM sent
  // non-array `questions`, call_id was missing, etc.). The model will see
  // the error and retry — this is NOT a user skip. Distinguish from the
  // silent-complete path below so the history card doesn't say "skipped".
  if (rawStatus === "failed" || resultContentStartsWithError) return "failed";
  // Tool call completed without a user reply — agent proceeded on its own.
  // Show "skipped" (static terminal state), not a loading spinner.
  if (rawStatus === "completed") return "failed";
  // `awaiting_user` means the question is still live and waiting for the
  // user. AskQuestionCard above the input handles the interactive state.
  // Show "pending" here so the history block acts as a status indicator
  // rather than prematurely rendering "Questions skipped" before the
  // agent:interaction_finalized event arrives to flip it to "answered".
  if (rawStatus === "awaiting_user") return "pending";
  return "pending";
}

const STATUS_ICON: Record<QuestionDisplayStatus, React.ReactNode> = {
  answered: getEventIcon("ask_user_questions", {
    status: "answered",
    className: "text-success-6",
  }),
  pending: getEventIcon("ask_user_questions", { className: "text-primary-6" }),
  failed: getEventIcon("ask_user_questions", { className: "text-primary-6" }),
};

function useQuestionStatusTitle(status: QuestionDisplayStatus): string {
  const { t } = useTranslation("sessions");
  const lifecycle = useLifecycleLabels("ask_user_questions");
  const answered = useToolLabelText("ask_user_questions", "answered");
  if (status === "answered") return answered;
  if (status === "failed") return t("tools.askUserQuestionsSkipped");
  return lifecycle.running;
}

const QuestionHistoryBlock: React.FC<{
  pairs: AnsweredPair[];
  status: QuestionDisplayStatus;
  eventId?: string;
  variant?: EventVariant;
  showActiveEventPainting: boolean;
}> = ({ pairs, status, eventId, variant, showActiveEventPainting }) => {
  const { t } = useTranslation("sessions");
  const titleText = useQuestionStatusTitle(status);
  const isSimulator = variant === "simulator";
  const locateEventId =
    status === "answered" && !isSimulator ? eventId : undefined;
  // Simulator surfaces the answered card in its own "Interactions" tab where
  // the user already navigated here to inspect the answer — collapsing it
  // by default forces an extra click on every row. Chat keeps the collapse
  // behaviour so answered cards don't clutter the scroll-back timeline.
  const defaultCollapsed = !isSimulator && status === "answered";
  const {
    isCollapsed,
    isHeaderHovered,
    handleHeaderClick,
    handleHeaderMouseEnter,
    handleHeaderMouseLeave,
    handleLocate,
  } = useBlockHeader({
    defaultCollapsed,
    eventId: locateEventId,
    collapseAllValue: true,
  });

  // In simulator mode the header acts as a static status row — body is
  // always rendered so users never have to expand to see their own answer.
  const collapsed = isSimulator ? false : isCollapsed;
  const hasBody = status === "answered" || status === "failed";

  return (
    <div
      className={getEventBlockContainerClasses(false)}
      data-tool-call-event-id={eventId}
      data-tool-call-name="ask_user_questions"
    >
      <EventBlockHeader
        isCollapsed={collapsed}
        withHover={false}
        onClick={locateEventId ? handleLocate : undefined}
        onNavigate={locateEventId ? handleLocate : undefined}
        onMouseEnter={handleHeaderMouseEnter}
        onMouseLeave={handleHeaderMouseLeave}
      >
        <EventBlockHeaderIcon
          icon={STATUS_ICON[status]}
          isCollapsed={collapsed}
          isHeaderHovered={isHeaderHovered}
          onToggle={isSimulator ? undefined : handleHeaderClick}
          hasContent={hasBody && !isSimulator}
          revealChevronOnIconHoverOnly={Boolean(locateEventId)}
        />
        <EventBlockHeaderTitle
          isLoading={status === "pending" && showActiveEventPainting}
        >
          {titleText}
        </EventBlockHeaderTitle>
      </EventBlockHeader>

      {hasBody && !collapsed && (
        <AskQuestionHistoryBody>
          <div className="flex flex-col gap-4">
            {pairs.map((pair, idx) => {
              if (!pair.question.trim()) return null;
              return (
                <div key={idx} className="flex flex-col gap-1.5">
                  <QuestionRow
                    number={idx + 1}
                    textClassName={ASK_QUESTION_EVENT_QUESTION_BODY}
                  >
                    {pair.question}
                  </QuestionRow>
                  {status === "answered" && pair.answers.length > 0 ? (
                    <div className="flex flex-col gap-1">
                      {pair.answers.map((answer, aidx) => (
                        <div
                          key={aidx}
                          className={ASK_QUESTION_EVENT_ANSWER_TEXT}
                        >
                          {answer}
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {status === "answered" && pair.answers.length === 0 ? (
                    <div className="chat-block-title italic text-text-3">
                      {t("chat.noAnswerProvided")}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </AskQuestionHistoryBody>
      )}
    </div>
  );
};

// ============================================
// Streaming placeholder — shown while `args.questions` hasn't streamed in yet
// ============================================

const QuestionStreamingPlaceholder: React.FC<{ eventId?: string }> = ({
  eventId,
}) => {
  const lifecycle = useLifecycleLabels("ask_user_questions");
  return (
    <div
      className={getEventBlockContainerClasses(false)}
      data-tool-call-event-id={eventId}
      data-tool-call-name="ask_user_questions"
    >
      <EventBlockHeader isCollapsed withHover={false}>
        <EventBlockHeaderIcon
          icon={STATUS_ICON.pending}
          isCollapsed
          isHeaderHovered={false}
          hasContent={false}
        />
        <EventBlockHeaderTitle isLoading>
          {lifecycle.running}
        </EventBlockHeaderTitle>
      </EventBlockHeader>
    </div>
  );
};

// ============================================
// Main Component
// ============================================

export const AskQuestionEvent: React.FC<AskQuestionEventProps> = (props) => {
  const normalizedProps = useNormalizedEventProps(props, "ask_user_questions");

  const { pairs, isAnswered, isRejected } = useMemo(
    () => extractAnsweredData(props),
    [props]
  );

  const rawStatus = props.event?.displayStatus as string | undefined;

  const eventId =
    props.event?.id ||
    props.event_id ||
    ((props as Record<string, unknown>).id as string | undefined);

  if (!normalizedProps) return null;

  const showActiveEventPainting =
    normalizedProps.showActiveEventPainting ?? false;
  const isStreaming =
    rawStatus !== "completed" &&
    rawStatus !== "failed" &&
    showActiveEventPainting;

  if (pairs.length === 0) {
    if (isStreaming) {
      return <QuestionStreamingPlaceholder eventId={eventId} />;
    }
    return null;
  }

  const status = resolveDisplayStatus(
    rawStatus,
    isAnswered,
    isRejected,
    (() => {
      const result = props.event?.result as Record<string, unknown> | undefined;
      const content =
        (typeof result?.content === "string" ? result.content : "") ||
        (typeof result?.observation === "string" ? result.observation : "");
      return content.startsWith("Error");
    })()
  );

  return (
    <QuestionHistoryBlock
      pairs={pairs}
      status={status}
      eventId={eventId}
      variant={props.variant}
      showActiveEventPainting={showActiveEventPainting}
    />
  );
};

AskQuestionEvent.displayName = "AskQuestionEvent";

export default AskQuestionEvent;
