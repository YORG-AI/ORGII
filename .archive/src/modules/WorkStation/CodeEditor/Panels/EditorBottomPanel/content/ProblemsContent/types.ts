/**
 * Types for Problems Content
 */

/**
 * Severity level for a diagnostic problem
 */
export type DiagnosticSeverity = "error" | "warning" | "info" | "hint";

/**
 * A diagnostic problem in a file
 */
export interface Diagnostic {
  /** Unique ID for the diagnostic */
  id: string;
  /** File path where the problem occurs */
  filePath: string;
  /** Line number (1-based) */
  line: number;
  /** Column number (1-based) */
  column: number;
  /** End line (1-based), optional */
  endLine?: number;
  /** End column (1-based), optional */
  endColumn?: number;
  /** Problem message */
  message: string;
  /** Severity level */
  severity: DiagnosticSeverity;
  /** Source of the diagnostic (e.g., "eslint", "typescript") */
  source?: string;
  /** Error/warning code */
  code?: string | number;
}

/**
 * Grouped diagnostics by file
 */
export interface DiagnosticsByFile {
  /** File path */
  filePath: string;
  /** Display name of the file */
  fileName: string;
  /** Number of errors */
  errorCount: number;
  /** Number of warnings */
  warningCount: number;
  /** List of diagnostics */
  diagnostics: Diagnostic[];
  /** Whether the file group is expanded */
  expanded: boolean;
}

/**
 * Summary of all diagnostics
 */
export interface DiagnosticSummary {
  /** Total number of errors */
  totalErrors: number;
  /** Total number of warnings */
  totalWarnings: number;
  /** Total number of info/hint messages */
  totalInfo: number;
}
