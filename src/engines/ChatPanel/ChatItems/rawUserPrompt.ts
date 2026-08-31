/**
 * Raw user-prompt resolution.
 *
 * A user bubble never renders the string the model received. `UserChatItem`
 * prefers the pill-format `displayText`, drops the backend's auto-expanded
 * reference block (`stripExpandedPillContent`), and runs the external-CLI
 * envelope normalizer over the remainder. All three are display conveniences.
 *
 * What actually entered the LLM history is the wire content persisted next to
 * it — `result.message.content`, written by `persist_user_message_event` for
 * native turns and by `user_message_chunk` for imported ones. This module
 * isolates that read so the "view raw prompt" affordance and its tests share
 * one definition of "raw".
 */
import { getUserMessageContent } from "@src/engines/SessionCore/core/atoms/actions.userMessageSync";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";

/**
 * The prompt text this turn handed to the model, or `""` when the event
 * carries none (synthetic rows, image-only turns with no text part).
 *
 * Falls back to `displayText` for legacy events persisted before the wire
 * content was stored: that fallback is still closer to the wire than the
 * bubble, since it keeps the expansion block the bubble strips.
 */
export function resolveRawUserPrompt(event: SessionEvent | undefined): string {
  if (!event) return "";
  return getUserMessageContent(event);
}
