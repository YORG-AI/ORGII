/**
 * projectOutgoingUserMessage — THE shared display/agent projection for every
 * outgoing user message.
 *
 * The composer keeps two copies of each message:
 *   - `displayContent`: the serialized editor text (pills intact, leading
 *     blank lines removed) that history renders and re-editing round-trips.
 *   - `agentContent`: the Agent-facing copy — skill pills expanded to their
 *     `/<name>` tokens, editor-internal `::base64` pill payloads stripped,
 *     the `/canvas` command replaced by its deterministic tool contract, and
 *     any fenced context blocks appended.
 *
 * Every entry point that dispatches a user message MUST run this projection:
 * composer submit (useSubmitMessage), edit-resend (useEditUserMessage), queue
 * edit save (editMessageAtom), the external-history fork override (ChatView),
 * and the Session Creator launch (inputPreparation). Skipping it leaks in
 * both directions — the model receives raw pill serialization, or the user
 * sees the internal agent contract.
 */
import { stripLeadingBlankLines } from "@src/util/data/stripLeadingBlankLines";

import { resolveAgentMessageContent } from "./agentMessageContent";
import {
  expandSkillPills,
  stripContextPillBase64,
} from "./outgoingTextTransforms";

export interface ProjectOutgoingUserMessageOptions {
  /** Serialized composer text (pills intact) — what history renders. */
  displayText: string;
  /**
   * Fenced/plaintext context blocks appended after the agent base (terminal
   * pill texts, PR/issue summaries, session references). Callers that can't
   * reach a live editor pass none.
   */
  contextBlocks?: string[];
  /** Composer-level opt-out (e.g. Work Log / channel composers). */
  enableAgentInterceptors?: boolean;
  /**
   * Capability gate for the Canvas interception: `false` for CLI sessions
   * (no `render_inline_canvas` tool) and for submissions with attached
   * images. See resolveAgentMessageContent.
   */
  allowCanvasInterception?: boolean;
}

export interface OutgoingUserMessageProjection {
  /** The text to persist/render as the user's message. */
  displayContent: string;
  /**
   * The Agent-facing copy, or `undefined` when it is identical to
   * `displayContent` (callers then dispatch the display copy alone).
   */
  agentContent: string | undefined;
}

export function projectOutgoingUserMessage(
  options: ProjectOutgoingUserMessageOptions
): OutgoingUserMessageProjection {
  const {
    displayText: rawDisplayText,
    contextBlocks = [],
    enableAgentInterceptors = true,
    allowCanvasInterception = true,
  } = options;

  const displayText = stripLeadingBlankLines(rawDisplayText);
  const { expanded, hasSkillPills } = expandSkillPills(displayText);
  const agentBase = stripContextPillBase64(expanded);

  const agentContent = resolveAgentMessageContent({
    displayText,
    agentBase,
    hasTransformedPills: hasSkillPills,
    contextBlocks,
    enableAgentInterceptors,
    allowCanvasInterception,
  });

  return {
    displayContent: displayText,
    agentContent:
      agentContent === undefined
        ? undefined
        : stripLeadingBlankLines(agentContent),
  };
}
