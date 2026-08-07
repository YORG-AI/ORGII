/**
 * TypeScript mirror of `src-tauri/src/agent_core/intelligence/external_import/types.rs`.
 *
 * Covers external `ItemKind`s end-to-end: rule-flavored sources (Cursor
 * IDE rules, Claude Code memory, GitHub Copilot instructions, Kiro
 * steering, and Codex), skill sources
 * (`SKILL.md` bundles and command Markdown files), MCP server configs,
 * and agent definitions. The apply path lives in `commands.rs::apply_single`
 * and persists each kind to its canonical ORGII home.
 */

export type SourceAgent =
  | "cursor_ide"
  | "claude_code"
  | "codex"
  | "copilot"
  | "kiro";

export type SourceScope =
  | { kind: "user_global" }
  | { kind: "workspace_local"; repoPath: string };

export type ItemKind = "policy" | "skill" | "mcp" | "agent_definition";

export interface ItemPreview {
  /** First non-frontmatter, non-empty Markdown line (≤ 200 chars). */
  summary: string;
  /** Frontmatter as ordered (key, value) pairs. Non-scalar values are
   *  serialized as JSON strings. */
  frontmatter: [string, string][];
  sizeBytes: number;
}

export type FidelityWarning =
  | { kind: "unmapped_field"; field: string }
  | { kind: "frontmatter_parse_error"; detail: string }
  | { kind: "large_bundle"; bytes: number }
  /**
   * Source frontmatter declared `readonly: true` (Cursor IDE / Codex
   * subagent semantics). ORGII has no top-level read-only switch on
   * AgentDefinition, so the apply path subtracts every write-capable
   * builtin tool via `excluded_tools`. The list is surfaced here so
   * the wizard can show users exactly what was downgraded.
   */
  | { kind: "readonly_downgraded"; excludedTools: string[] };

export interface DetectedItem {
  sourceAgent: SourceAgent;
  sourceScope: SourceScope;
  kind: ItemKind;
  /** Absolute path to the source file. */
  sourcePath: string;
  /** Suggested ORGII-side name; deduped against the target dir. */
  suggestedName: string;
  alreadyImported: boolean;
  fidelityWarnings: FidelityWarning[];
  preview: ItemPreview;
}

export interface ImportSelection {
  sourceAgent: SourceAgent;
  sourceScope: SourceScope;
  kind: ItemKind;
  sourcePath: string;
  /** Destination repo for repo-scoped imports. Agent definitions ignore this. */
  targetRepoPath?: string | null;
  /** Final ORGII-side name (typically `DetectedItem.suggestedName`). */
  targetName: string;
  /** When true, an existing target with the same name is overwritten. */
  overwrite?: boolean;
}

export type ImportStatus = "imported" | "skipped" | "failed";

export interface ImportItemReport {
  sourcePath: string;
  targetName: string;
  kind: ItemKind;
  status: ImportStatus;
  error?: string | null;
}

export interface ImportReport {
  items: ImportItemReport[];
}
