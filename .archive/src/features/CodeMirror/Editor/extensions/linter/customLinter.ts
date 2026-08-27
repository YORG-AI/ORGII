/**
 * Custom linter extension for CodeMirror.
 *
 * Wraps a user-provided linting function into a CodeMirror linter extension.
 */
import type { Diagnostic } from "@/src/modules/WorkStation/CodeEditor/Panels/EditorBottomPanel/content/ProblemsContent/types";
import {
  type Diagnostic as CodeMirrorDiagnostic,
  linter,
} from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import { createLogger } from "@src/hooks/logger";

import { convertAndSortDiagnostics } from "./diagnosticsConverter";

const log = createLogger("Linter");

/**
 * Create a CodeMirror linter extension from a custom linting function.
 */
export function createCustomLinterExtension(
  customLinter: (content: string) => Diagnostic[],
  onDiagnosticsChange?: (diagnostics: Diagnostic[]) => void
): Extension {
  const lintFunction = (view: EditorView): CodeMirrorDiagnostic[] => {
    try {
      const content = view.state.doc.toString();
      const diagnostics = customLinter(content);

      if (onDiagnosticsChange) {
        onDiagnosticsChange(diagnostics);
      }

      return convertAndSortDiagnostics(diagnostics, view.state.doc);
    } catch (error) {
      log.error("[Linter] Error during custom linting:", error);
      return [];
    }
  };

  return linter(lintFunction, { delay: 500 });
}
