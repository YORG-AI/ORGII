/**
 * outgoingTextTransforms — leaf helpers shared by every outgoing user-message
 * projection (composer submit, edit-resend, queue edit, fork override,
 * Session Creator launch).
 *
 * Keep this module dependency-free: it is imported from both the ChatPanel
 * submit pipeline and store-level atoms, and the canvas slash-command parser
 * uses it to project the creation request extracted from display text.
 */

/**
 * Expand skill pills for the Agent. `displayText` keeps `name [skill:/<name>]`
 * for rendering pills in history; the Rust backend expects `/<name>` to expand
 * skill content, so we extract the path token (already starts with "/")
 * directly.
 */
const SKILL_PILL_REGEX = /([^[]+?)\s*\[skill:([^\]]+)\]/g;

export interface SkillPillExpansion {
  /** Text with every `label [skill:/name]` collapsed to `/name`. */
  expanded: string;
  /** True when at least one skill pill was expanded. */
  hasSkillPills: boolean;
}

export function expandSkillPills(text: string): SkillPillExpansion {
  const expanded = text.replace(
    SKILL_PILL_REGEX,
    (_match, _displayName, skillPath: string) => skillPath
  );
  return { expanded, hasSkillPills: expanded !== text };
}

/**
 * Strip the `::<base64>` payload from serialized context pills
 * (`[paste:path::encoded]` → `[paste:path]`).
 *
 * `serializePillNode` embeds the pill's stored text as a base64 blob so the
 * composer can round-trip it back into an editable pill (drafts / edit mode).
 * That blob is editor-internal — the LLM must never see it. The submit flow
 * already re-attaches each context pill's *plaintext* as a fenced ```block```
 * (see `contextBlocks` in useSubmitMessage), so leaving the base64 in the
 * agent content both duplicates the payload AND feeds the model a multi-KB
 * opaque token soup — which has triggered Anthropic `stop_reason=refusal`
 * (empty response, turn ends with no output). We keep the lightweight
 * `[paste:path]` reference so the fenced block still has an anchor, but drop
 * the blob.
 */
const CONTEXT_PILL_TYPE_ALTERNATION =
  "paste|terminal|browser|workitem|dom-element|dom-component|pr|issue";
const CONTEXT_PILL_BASE64_REGEX = new RegExp(
  `\\[(${CONTEXT_PILL_TYPE_ALTERNATION}):([^\\]]+?)::[A-Za-z0-9+/=]+\\]`,
  "g"
);

export function stripContextPillBase64(text: string): string {
  return text.replace(CONTEXT_PILL_BASE64_REGEX, "[$1:$2]");
}
