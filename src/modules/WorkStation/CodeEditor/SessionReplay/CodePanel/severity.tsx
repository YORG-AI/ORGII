/**
 * Severity markers for parsed search-result lines.
 *
 * Search results streamed from the agent can carry a `[error] / [warning] /
 * [info] / [hint]` prefix. These helpers used to live in the Problems panel
 * (`EditorBottomPanel/content/ProblemsContent`), which was archived along with
 * the rest of the user-facing LSP/lint surface — see `.archive/README.md`. They
 * are inlined here because this rendering is unrelated to LSP diagnostics.
 */
import React from "react";

import {
  Alert01Icon,
  AlertCircleIcon,
  HugeiconsIcon,
  InformationCircleIcon,
} from "@src/icons";

export type DiagnosticSeverity = "error" | "warning" | "info" | "hint";

export function getSeverityIcon(severity: DiagnosticSeverity): React.ReactNode {
  const iconSize = 14;
  const stroke = 1.75;
  switch (severity) {
    case "error":
      return (
        <HugeiconsIcon
          icon={AlertCircleIcon}
          data-icon="alert-circle"
          size={iconSize}
          strokeWidth={stroke}
          className="text-danger-6"
        />
      );
    case "warning":
      return (
        <HugeiconsIcon
          icon={Alert01Icon}
          data-icon="alert-triangle"
          size={iconSize}
          strokeWidth={stroke}
          className="text-warning-6"
        />
      );
    case "info":
    case "hint":
      return (
        <HugeiconsIcon
          icon={InformationCircleIcon}
          data-icon="info"
          size={iconSize}
          strokeWidth={stroke}
          className="text-text-3"
        />
      );
  }
}
