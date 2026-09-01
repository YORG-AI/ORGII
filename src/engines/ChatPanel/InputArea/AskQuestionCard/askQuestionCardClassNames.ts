/**
 * Tailwind class maps for ask-question UI (chat input + session replay).
 * Replaces the former AskQuestionCard SCSS module.
 */

export const ASK_QUESTION_CARD_CONTENT =
  "scrollbar-overlay flex min-h-0 max-h-[min(240px,30vh)] flex-col overflow-y-auto px-1 pb-2 pt-1";

export const ASK_QUESTION_CARD_QUESTION = "mb-2 flex items-start gap-2 pl-2.5";

export const ASK_QUESTION_CARD_QUESTION_NUMBER =
  "shrink-0 chat-block-title leading-normal font-semibold text-text-2";

export const ASK_QUESTION_CARD_QUESTION_TEXT =
  "flex-1 chat-block-title leading-normal font-medium text-text-1 [&_p]:m-0 [&_code]:rounded [&_code]:bg-fill-2 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:chat-block-content";

export const ASK_QUESTION_CARD_OPTIONS = "flex flex-col gap-0.5";

export const ASK_QUESTION_CARD_OPTION_BASE =
  "flex w-full cursor-pointer items-start gap-2.5 rounded-md border-none bg-transparent px-2 py-1 text-left transition-all duration-150 ease-in-out hover:bg-fill-2";

export const ASK_QUESTION_CARD_OPTION_SELECTED = "bg-fill-2 hover:bg-fill-2";

export const ASK_QUESTION_CARD_OPTION_TEXT =
  "flex-1 chat-block-content leading-[22px] text-text-1";

export const ASK_QUESTION_CARD_OPTION_TEXT_MUTED = "text-text-3";

export const ASK_QUESTION_CARD_FOOTER =
  "flex items-center justify-between px-2.5 py-1.5";

export const ASK_QUESTION_CARD_FOOTER_LEFT = "flex items-center gap-3";

export const ASK_QUESTION_CARD_FOOTER_RIGHT = "flex items-center gap-1.5";

// ============================================
// AskQuestionEvent (chat history) — content chrome matches ThinkingEvent
// ============================================

/** Left rule + indent — same as ThinkingEvent chat variant */
export const ASK_QUESTION_EVENT_CONTENT_LINE =
  "ml-[14px] border-l border-border-1 py-0.5";

export const ASK_QUESTION_EVENT_CONTENT_INNER = "pl-3";

/** Question Markdown (unified pending + answered) — uses chat-block-title token, matches card number */
export const ASK_QUESTION_EVENT_QUESTION_BODY =
  "min-w-0 flex-1 chat-block-title leading-normal font-medium text-text-1 [&_p]:m-0";

/** Answered: answer body line (min-w-0 for flex parents) */
export const ASK_QUESTION_EVENT_ANSWER_TEXT =
  "min-w-0 chat-block-title leading-normal text-text-2";
