/**
 * ESLint output parser.
 *
 * Parses ESLint JSON output into app Diagnostic format.
 */
import type { Diagnostic } from "@/src/modules/WorkStation/CodeEditor/Panels/EditorBottomPanel/content/ProblemsContent/types";

/**
 * Helper to parse ESLint-style error output.
 * This can be used if you have ESLint running via a command.
 */
export function parseESLintOutput(
  output: string,
  filePath: string
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  try {
    // ESLint JSON output format
    const result = JSON.parse(output);

    if (Array.isArray(result) && result.length > 0) {
      const fileResult = result[0];

      if (fileResult.messages) {
        fileResult.messages.forEach(
          (msg: {
            line: number;
            column: number;
            endLine?: number;
            endColumn?: number;
            severity: 1 | 2;
            message: string;
            ruleId?: string;
          }) => {
            diagnostics.push({
              id: `${filePath}-${msg.line}-${msg.column}-${msg.ruleId}`,
              filePath,
              line: msg.line,
              column: msg.column,
              endLine: msg.endLine,
              endColumn: msg.endColumn,
              message: msg.message,
              severity: msg.severity === 2 ? "error" : "warning",
              source: "eslint",
              code: msg.ruleId,
            });
          }
        );
      }
    }
  } catch (_error) {
    // Failed to parse ESLint output
  }

  return diagnostics;
}
