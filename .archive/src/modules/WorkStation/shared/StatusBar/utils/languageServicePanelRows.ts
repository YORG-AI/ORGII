/**
 * languageServicePanelRows
 *
 * Projects the diagnostic health state into the rows rendered by the
 * EditorStatusBar language-service dropdown panel.
 */
import type { DiagnosticHealthState } from "@src/store/workstation/codeEditor/diagnostics";

import type { PanelRow } from "../types";
import {
  diagnosticSourceStatusLabel,
  diagnosticStatusToUi,
  mergeLspByBaseLanguage,
} from "./statusBarUtils";

export function buildLanguageServicePanelRows(
  diagnosticHealth: DiagnosticHealthState,
  t: (key: string) => string
): PanelRow[] {
  const rows: PanelRow[] = [];

  const mergedLsp = mergeLspByBaseLanguage(diagnosticHealth);

  for (const [lang, entry] of mergedLsp) {
    const statusText = diagnosticSourceStatusLabel(entry.status, t);
    rows.push({
      kind: "pair",
      key: `lsp-${lang}`,
      left: "LSP",
      right: `${lang} · ${statusText}`,
      uiStatus: diagnosticStatusToUi(entry.status),
    });
  }

  if (diagnosticHealth.eslint) {
    const statusText = diagnosticSourceStatusLabel(
      diagnosticHealth.eslint.status,
      t
    );
    rows.push({
      kind: "pair",
      key: "eslint",
      left: "ESLint",
      right: statusText,
      uiStatus: diagnosticStatusToUi(diagnosticHealth.eslint.status),
    });
  }

  if (rows.length === 0) {
    rows.push({
      kind: "empty",
      key: "empty",
      message: t("workstation.noLanguageServicesActive"),
    });
  }

  return rows;
}
