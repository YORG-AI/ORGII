/**
 * LSP Types
 *
 * TypeScript types matching Rust LSP types for frontend-backend communication.
 */

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface LspDiagnostic {
  range: Range;
  severity?: number; // 1=Error, 2=Warning, 3=Info, 4=Hint
  message: string;
  source?: string;
  code?: string | number;
}

export interface CompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string;
  insertText?: string;
  sortText?: string;
}

export interface Location {
  uri: string;
  range: Range;
}

export interface Hover {
  contents: string;
  range?: Range;
}

/**
 * Map LSP severity to our Diagnostic type
 */
export function lspDiagnosticToAppDiagnostic(
  lspDiag: LspDiagnostic,
  filePath: string
): import("@src/modules/WorkStation/CodeEditor/Panels/EditorBottomPanel/content/ProblemsContent/types").Diagnostic {
  const severityMap: Record<number, "error" | "warning" | "info" | "hint"> = {
    1: "error",
    2: "warning",
    3: "info",
    4: "hint",
  };

  return {
    id: `${filePath}-${lspDiag.range.start.line}-${lspDiag.range.start.character}`,
    filePath,
    line: lspDiag.range.start.line + 1, // LSP is 0-based, we use 1-based
    column: lspDiag.range.start.character + 1,
    endLine: lspDiag.range.end.line + 1,
    endColumn: lspDiag.range.end.character + 1,
    message: lspDiag.message,
    severity: severityMap[lspDiag.severity || 1] || "error",
    source: lspDiag.source,
    code: lspDiag.code,
  };
}
