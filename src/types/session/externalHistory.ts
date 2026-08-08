/** Canonical source ids shared by history adapters and collaboration wire metadata. */
export const IMPORTED_HISTORY_SOURCE_IDS = [
  "cursor_ide",
  "cursor_cli",
  "codex_app",
  "claude_code",
  "opencode",
  "windsurf",
  "workbuddy",
  "trae",
  "cline",
  "warp",
  "zcode",
  "qoder",
  "mimo_code",
  "omp",
  "pi",
  "qoder_cli",
  "qwen_code",
  "copilot",
  "kimi",
] as const;

export type ImportedHistorySourceId =
  (typeof IMPORTED_HISTORY_SOURCE_IDS)[number];
