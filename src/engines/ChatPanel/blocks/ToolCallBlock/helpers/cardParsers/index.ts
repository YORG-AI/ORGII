/**
 * Rich card parsers — derive structured card data from tool args + results
 * for file, website, work-item, and project tool calls.
 *
 * Split modules:
 *   primitives.ts        — shared value coercion helpers
 *   file.ts              — parseFileCardResult
 *   website.ts           — parseWebsiteCardResult
 *   workItem.ts          — parseWorkItemCardResult, parseProjectCardResult
 *   command.ts           — parseCommandResult
 *   agentMessage.ts      — parseAgentMessageCard
 *   orgtrackEnvelope.ts  — parseOrgtrackEnvelope
 */
export { parseAgentMessageCard } from "./agentMessage";
export { parseCommandResult } from "./command";
export { parseFileCardResult } from "./file";
export { parseOrgtrackEnvelope } from "./orgtrackEnvelope";
export type { OrgtrackEnvelopeContext } from "./orgtrackEnvelope";
export { parseWebsiteCardResult } from "./website";
export { parseProjectCardResult, parseWorkItemCardResult } from "./workItem";
