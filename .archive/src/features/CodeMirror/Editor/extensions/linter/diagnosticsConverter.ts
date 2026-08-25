/**
 * Diagnostic conversion and utility helpers.
 *
 * Converts between app Diagnostic format and CodeMirror Diagnostic format,
 * and provides shared utilities (timeout, sorting).
 */
import type { Diagnostic } from "@/src/modules/WorkStation/CodeEditor/Panels/EditorBottomPanel/content/ProblemsContent/types";
import type { Diagnostic as CodeMirrorDiagnostic } from "@codemirror/lint";

interface DocInfo {
  line: (n: number) => { from: number; to: number };
  lines: number;
  length: number;
}

/**
 * Convert our Diagnostic type to CodeMirror diagnostic
 */
export function toCodeMirrorDiagnostic(
  diagnostic: Diagnostic,
  doc: DocInfo
): CodeMirrorDiagnostic {
  // Calculate position from line/column (1-based to 0-based)
  const line = Math.min(Math.max(1, diagnostic.line), doc.lines);
  const lineInfo = doc.line(line);
  const from = lineInfo.from + Math.max(0, diagnostic.column - 1);

  let to = from + 1; // Default to single character
  if (diagnostic.endLine !== undefined && diagnostic.endColumn !== undefined) {
    const endLine = Math.min(Math.max(1, diagnostic.endLine), doc.lines);
    const endLineInfo = doc.line(endLine);
    to = endLineInfo.from + Math.max(0, diagnostic.endColumn - 1);
  }

  // Ensure valid range: from <= to and both within document bounds
  const validFrom = Math.max(0, Math.min(from, doc.length));
  const validTo = Math.max(validFrom, Math.min(to, doc.length));

  return {
    from: validFrom,
    to: validTo,
    severity: diagnostic.severity,
    message: diagnostic.message,
    source: diagnostic.source,
  };
}

/**
 * Convert diagnostics to CodeMirror format, filter invalid, and sort by position.
 */
export function convertAndSortDiagnostics(
  diagnostics: Diagnostic[],
  doc: DocInfo
): CodeMirrorDiagnostic[] {
  const cmDiagnostics = diagnostics
    .map((diag) => toCodeMirrorDiagnostic(diag, doc))
    .filter((diag) => diag.from < diag.to || diag.from === diag.to);

  cmDiagnostics.sort((diagA, diagB) => {
    if (diagA.from !== diagB.from) {
      return diagA.from - diagB.from;
    }
    return diagA.to - diagB.to;
  });

  return cmDiagnostics;
}

/**
 * Helper to add timeout to a promise
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), timeoutMs)),
  ]);
}
