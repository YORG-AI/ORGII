/** Pure predicates behind the thread-list / turn-chrome agent affordances. */

/**
 * The composer sugar token (design §1): promotion is EXPLICIT — a literal
 * prefix over the same create RPC, never NL intent detection.
 */
export const AGENT_COMPOSER_PREFIX = "@agent ";

/**
 * Literal `@agent ` detection on the SUBMITTED body (composers trim before
 * submit): case-sensitive, anchored at index 0 (no leading-whitespace
 * tolerance — a trimmed body can't have any), and the trailing space is
 * part of the token, so "@agents please" and a bare "@agent" are ordinary
 * comments. The prefix must be followed by content: the comment posts
 * VERBATIM and an empty brief would promote a thread that says nothing.
 */
export function detectAgentPrefix(body: string): boolean {
  return (
    body.startsWith(AGENT_COMPOSER_PREFIX) &&
    body.slice(AGENT_COMPOSER_PREFIX.length).trim().length > 0
  );
}

export interface AgentMentionBodyParts {
  mention: "@agent";
  brief: string;
}

/**
 * Composer suggestion is deliberately prefix-only and canonical: typing `@`
 * or any leading prefix of `@agent` offers the one supported agent target.
 * Once a space/body exists the suggestion closes; manual full-token input
 * continues through the same submit parser.
 */
export function shouldShowAgentSuggestion(body: string): boolean {
  return (
    body.length > 0 &&
    body.length <= "@agent".length &&
    "@agent".startsWith(body)
  );
}

/**
 * Splits the submitted sugar into a semantic mention token and its brief.
 * Keeping this beside the detector ensures the rendered pill and task
 * creation always use the exact same grammar.
 */
export function splitAgentMentionBody(
  body: string
): AgentMentionBodyParts | null {
  if (!detectAgentPrefix(body)) return null;
  return {
    mention: "@agent",
    brief: body.slice(AGENT_COMPOSER_PREFIX.length),
  };
}
