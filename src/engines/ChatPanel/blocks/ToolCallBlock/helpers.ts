/**
 * Tool-call block helpers — re-exported from split modules for backwards
 * compatibility. All imports of "./helpers" continue to resolve correctly.
 *
 * Source files:
 *   helpers/argsSummary.ts   — screenshot utilities + extractArgsSummary
 *   helpers/resultParsers.ts — extractResultText, parseSearchFiles, …
 *   helpers/cardParsers/     — parseFileCard, parseWebsiteCard, …
 */
export {
  hasStyledOutput,
  isBrowserTool,
  isSearchTool,
  isShellTool,
} from "@src/engines/SessionCore/rendering/registry/toolCategories";

export {
  extractArgsSummary,
  extractScreenshotIds,
  stripScreenshotMarkers,
} from "./helpers/argsSummary";

export {
  buildWorkspaceInfoRows,
  extractResultText,
  extractScreenshot,
  hasNonEmptyResultValues,
  isBrowserSnapshotResult,
  isErrorResult,
  parseAwaitListingResult,
  parseManageLspResult,
  parseManageWorkspaceResult,
  parseProjectToolListResult,
  parseSearchFilesResult,
} from "./helpers/resultParsers";

export {
  parseAgentMessageCard,
  parseCommandResult,
  parseOrgtrackEnvelope,
  parseFileCardResult,
  parseProjectCardResult,
  parseWebsiteCardResult,
  parseWorkItemCardResult,
} from "./helpers/cardParsers";

export { extractToolSource } from "./helpers/toolSource";
export type { ToolSourceTarget } from "./helpers/toolSource";
