/**
 * Search Results Serialization
 *
 * Converts search results into a VS Code-style text document format.
 * This format is rendered in a single CodeMirror instance with match decorations.
 *
 * Document format:
 * ```
 * # Query: searchterm
 * # Mode: regex
 *
 * 5 results in 2 files
 *
 * src/components/Button.tsx:
 *   12: const handleClick = () => {
 *   45: onClick(event);
 *
 * src/utils/helpers.ts:
 *   8: export function onClick() {
 * ```
 */
import type { SearchMatch, SearchResultFile } from "./types";

// ============================================
// Types
// ============================================

/**
 * Range within the serialized document where a match is located
 */
export interface MatchRange {
  /** Line number in the serialized document (1-indexed) */
  docLine: number;
  /** Start column in the serialized document (1-indexed) */
  startColumn: number;
  /** End column in the serialized document (1-indexed) */
  endColumn: number;
  /** Original file path */
  filePath: string;
  /** Original line number in the source file */
  sourceLine: number;
  /** Original column in the source file */
  sourceColumn: number;
}

/**
 * File path location within the serialized document
 */
export interface FilePathRange {
  /** Line number in the serialized document (1-indexed) */
  docLine: number;
  /** Original file path */
  filePath: string;
  /** First match line in the source file */
  firstMatchLine: number;
}

/**
 * Result of serializing search results
 */
export interface SerializedSearchResult {
  /** The serialized text content */
  text: string;
  /** Ranges of matches for highlighting */
  matchRanges: MatchRange[];
  /** File path line locations for navigation */
  filePathRanges: FilePathRange[];
  /** Total number of results */
  totalResults: number;
  /** Total number of files */
  totalFiles: number;
}

// ============================================
// Configuration
// ============================================

export interface SerializationConfig {
  /** Current search query */
  query?: string;
  /** Search mode */
  mode?: string;
  /** Case sensitive */
  caseSensitive?: boolean;
  /** Whole word */
  wholeWord?: boolean;
  /** Use regex */
  useRegex?: boolean;
  /** Repository path for relative paths */
  repoPath?: string;
}

// ============================================
// Helper Functions
// ============================================

/**
 * Get relative path from repo root
 */
function getRelativePath(filePath: string, repoPath: string): string {
  if (!filePath || !repoPath) return filePath;

  const normalizedFile = filePath.replace(/\\/g, "/");
  const normalizedRepo = repoPath.replace(/\\/g, "/");

  if (normalizedFile.startsWith(normalizedRepo)) {
    return normalizedFile.slice(normalizedRepo.length).replace(/^\//, "");
  }

  return filePath;
}

/**
 * Calculate the longest line number width for padding
 */
function getLongestLineWidth(results: SearchResultFile[]): number {
  let maxLine = 0;
  for (const file of results) {
    for (const match of file.matches) {
      maxLine = Math.max(maxLine, match.line, match.end_line);
    }
  }
  return String(maxLine).length;
}

/**
 * Escape special characters in the query for display
 */
function escapeQuery(query: string): string {
  return query.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}

// ============================================
// Main Serialization Function
// ============================================

/**
 * Serialize search results into a VS Code-style text document
 *
 * @param results - Array of search result files
 * @param config - Serialization configuration
 * @returns Serialized result with text, match ranges, and metadata
 */
export function serializeSearchResults(
  results: SearchResultFile[],
  config: SerializationConfig = {}
): SerializedSearchResult {
  const lines: string[] = [];
  const matchRanges: MatchRange[] = [];
  const filePathRanges: FilePathRange[] = [];

  const repoPath = config.repoPath || "";
  const lineNumWidth = getLongestLineWidth(results);

  // ============================================
  // Header Section
  // ============================================

  // Query line
  if (config.query) {
    lines.push(`# Query: ${escapeQuery(config.query)}`);
  }

  // Flags line
  const flags: string[] = [];
  if (config.caseSensitive) flags.push("CaseSensitive");
  if (config.wholeWord) flags.push("WordMatch");
  if (config.useRegex) flags.push("RegExp");
  if (config.mode && config.mode !== "regex") {
    flags.push(config.mode.charAt(0).toUpperCase() + config.mode.slice(1));
  }

  if (flags.length > 0) {
    lines.push(`# Flags: ${flags.join(" ")}`);
  }

  // Empty line after header
  if (lines.length > 0) {
    lines.push("");
  }

  // ============================================
  // Results Summary
  // ============================================

  let totalResults = 0;
  for (const file of results) {
    totalResults += file.matches.length;
  }

  const fileCount = results.length;
  const resultText =
    totalResults === 1 ? "1 result" : `${totalResults} results`;
  const fileText = fileCount === 1 ? "1 file" : `${fileCount} files`;

  if (totalResults > 0) {
    lines.push(`${resultText} in ${fileText}`);
    lines.push("");
  } else {
    lines.push("No results found");
    lines.push("");
  }

  // ============================================
  // Results Content
  // ============================================

  for (const file of results) {
    const relativePath = getRelativePath(file.file_path, repoPath);

    // File header line
    const fileHeaderLine = lines.length + 1; // 1-indexed
    lines.push(`${relativePath}:`);

    // Track file path for navigation
    const firstMatch = file.matches[0];
    filePathRanges.push({
      docLine: fileHeaderLine,
      filePath: file.file_path,
      firstMatchLine: firstMatch ? firstMatch.line : 1,
    });

    // Sort matches by line number
    const sortedMatches = [...file.matches].sort((a, b) => a.line - b.line);

    // Group matches by line to avoid duplicate lines
    const matchesByLine = new Map<number, SearchMatch[]>();
    for (const match of sortedMatches) {
      const lineMatches = matchesByLine.get(match.line) || [];
      lineMatches.push(match);
      matchesByLine.set(match.line, lineMatches);
    }

    // Render each line with matches
    for (const [lineNum, lineMatches] of matchesByLine) {
      // Get the line text from the first match (they should all have the same text)
      const text = lineMatches[0].text;

      // Format: "  123: code here"
      const paddedLineNum = String(lineNum).padStart(lineNumWidth, " ");
      const prefix = `  ${paddedLineNum}: `;
      const lineContent = prefix + text;

      const docLineNum = lines.length + 1; // 1-indexed
      lines.push(lineContent);

      // Track match ranges for highlighting
      for (const match of lineMatches) {
        // Calculate column position in the serialized line
        // The match.column is 1-indexed in the original text
        const column = match.column;
        const endColumn = match.end_column;

        // In the serialized line, the text starts after the prefix
        const startCol = prefix.length + column;
        const endCol = prefix.length + endColumn;

        matchRanges.push({
          docLine: docLineNum,
          startColumn: startCol,
          endColumn: endCol,
          filePath: file.file_path,
          sourceLine: match.line,
          sourceColumn: match.column,
        });
      }
    }

    // Empty line between files
    lines.push("");
  }

  return {
    text: lines.join("\n"),
    matchRanges,
    filePathRanges,
    totalResults,
    totalFiles: fileCount,
  };
}
