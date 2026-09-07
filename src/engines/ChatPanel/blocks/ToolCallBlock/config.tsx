export { getToolIcon } from "@src/config/toolIcons";

export const DEFAULT_VISIBLE_LINES = 4;
/** Browser snapshot / a11y trees — keep initial slice small; expand shows rest */
export const BROWSER_SNAPSHOT_VISIBLE_LINES = 4;

/** Max chars of snapshot text mounted in chat UI (rest omitted; avoids huge DOM) */
export const TOOL_SNAPSHOT_MAX_CHARS = 32_000;

export const SEARCH_NO_RESULT_MESSAGES = new Set([
  "No files found.",
  "No matches found.",
  "No symbols found.",
  "No projects found.",
]);
