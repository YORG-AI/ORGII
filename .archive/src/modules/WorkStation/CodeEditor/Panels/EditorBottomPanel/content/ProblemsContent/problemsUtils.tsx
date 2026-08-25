import { AlertCircle, AlertTriangle, Info } from "lucide-react";
import React from "react";

import type { FlattenedTreeNode } from "@src/components/VirtualizedStickyTree";

import type {
  Diagnostic,
  DiagnosticSeverity,
  DiagnosticsByFile,
} from "./types";

interface ProblemsNode {
  path: string;
  name: string;
  isFolder?: boolean;
  expanded?: boolean;
  nodeType: "file-header" | "diagnostic";
  group?: DiagnosticsByFile;
  diagnostic?: Diagnostic;
}

export type { ProblemsNode };

export function groupDiagnosticsByFile(
  diagnostics: Diagnostic[]
): DiagnosticsByFile[] {
  const grouped = new Map<string, DiagnosticsByFile>();

  for (const diagnostic of diagnostics) {
    const { filePath } = diagnostic;
    const fileName = filePath.split("/").pop() || filePath;

    if (!grouped.has(filePath)) {
      grouped.set(filePath, {
        filePath,
        fileName,
        errorCount: 0,
        warningCount: 0,
        diagnostics: [],
        expanded: true,
      });
    }

    const group = grouped.get(filePath)!;
    group.diagnostics.push(diagnostic);

    if (diagnostic.severity === "error") {
      group.errorCount++;
    } else if (diagnostic.severity === "warning") {
      group.warningCount++;
    }
  }

  return Array.from(grouped.values()).sort((groupA, groupB) =>
    groupA.fileName.localeCompare(groupB.fileName)
  );
}

export function getSeverityIcon(severity: DiagnosticSeverity): React.ReactNode {
  const iconSize = 14;
  const stroke = 1.75;
  switch (severity) {
    case "error":
      return (
        <AlertCircle
          size={iconSize}
          strokeWidth={stroke}
          className="text-danger-6"
        />
      );
    case "warning":
      return (
        <AlertTriangle
          size={iconSize}
          strokeWidth={stroke}
          className="text-warning-6"
        />
      );
    case "info":
    case "hint":
      return (
        <Info size={iconSize} strokeWidth={stroke} className="text-text-3" />
      );
  }
}

export function formatDiagnosticLocationSuffix(diagnostic: Diagnostic): string {
  const segments: string[] = [
    `Ln ${diagnostic.line}, Col ${diagnostic.column}`,
  ];
  if (diagnostic.source) {
    segments.push(diagnostic.source);
  }
  if (diagnostic.code !== undefined && diagnostic.code !== "") {
    segments.push(`(${String(diagnostic.code)})`);
  }
  return segments.join(" · ");
}

export function flattenProblemsTree(
  groups: DiagnosticsByFile[],
  collapsedFiles: Set<string>
): FlattenedTreeNode<ProblemsNode>[] {
  const result: FlattenedTreeNode<ProblemsNode>[] = [];

  for (const group of groups) {
    const isExpanded = !collapsedFiles.has(group.filePath);

    result.push({
      node: {
        path: `file:${group.filePath}`,
        name: group.fileName,
        isFolder: true,
        expanded: isExpanded,
        nodeType: "file-header",
        group: { ...group, expanded: isExpanded },
      },
      depth: 0,
    });

    if (isExpanded) {
      for (const diagnostic of group.diagnostics) {
        result.push({
          node: {
            path: `diag:${diagnostic.id}`,
            name: diagnostic.message,
            isFolder: false,
            nodeType: "diagnostic",
            diagnostic,
          },
          depth: 1,
        });
      }
    }
  }

  return result;
}
