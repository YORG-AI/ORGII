/**
 * Shared column widths for integrations models table (flat list + group view)
 * so switching view mode does not jump column alignment.
 */
export const INTEGRATIONS_MODELS_TABLE_COL_WIDTH = {
  sources: "clamp(200px, 24vw, 320px)",
  status: "88px",
} as const;
