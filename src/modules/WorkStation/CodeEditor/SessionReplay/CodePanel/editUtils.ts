import { shouldTrustDiffStartLines } from "../converters/fileConverter";
import type { FileOperationEntry } from "../types";

/**
 * Extract start line number from old_string content or event context.
 * Returns 0 if not determinable.
 */
export function getEditStartLine(op: FileOperationEntry): number {
  if (op.newStartLine) return op.newStartLine;
  if (!op.event || !shouldTrustDiffStartLines(op.event)) return 0;

  const event = op.event as unknown as {
    context_start_line?: number;
    start_line?: number;
    line_number?: number;
    parameters?: { start_line?: number; line_number?: number };
    extracted?: { newStartLine?: number; oldStartLine?: number };
  };

  if (event?.extracted?.newStartLine) return event.extracted.newStartLine;
  if (event?.context_start_line) return event.context_start_line;
  if (event?.start_line) return event.start_line;
  if (event?.line_number) return event.line_number;
  if (event?.parameters?.start_line) return event.parameters.start_line;
  if (event?.parameters?.line_number) return event.parameters.line_number;

  return 0;
}
