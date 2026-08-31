/**
 * searchResultsParsers
 *
 * Pure parser/utility functions for SearchResultsContent.
 * Extracted to keep the main component file under 600 lines.
 */
import { getBasename } from "./pathUtils";
import type { DiagnosticSeverity } from "./severity";

export function isFolderLikePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.endsWith("/")) return true;
  const baseName = getBasename(normalized);
  return Boolean(baseName) && !baseName.includes(".");
}

export function parseMatchCountText(text: string): number | undefined {
  const match = text.match(/^(\d+)\s+matches?$/);
  if (!match) return undefined;
  const count = Number.parseInt(match[1], 10);
  return Number.isFinite(count) ? count : undefined;
}

export function parseDiagnosticContent(content: string): {
  severity: DiagnosticSeverity;
  message: string;
  source?: string;
} {
  let severity: DiagnosticSeverity = "info";
  let remaining = content.trim();
  const severityMatch = remaining.match(/^\[(error|warning|info|hint)\]\s*/i);
  if (severityMatch) {
    severity = severityMatch[1].toLowerCase() as DiagnosticSeverity;
    remaining = remaining.slice(severityMatch[0].length);
  }
  let source: string | undefined;
  const sourceMatch = remaining.match(/\s*\(([^)]+)\)\s*$/);
  if (sourceMatch) {
    source = sourceMatch[1].trim();
    remaining = remaining
      .slice(0, sourceMatch.index ?? remaining.length)
      .trim();
  }
  return { severity, message: remaining, source };
}

export function parseSearchKeywords(query: string): string[] {
  const keywords = query
    .split(/[|,\s]+/)
    .map((keyword) => keyword.trim())
    .filter(Boolean);
  return Array.from(new Set(keywords));
}
