/**
 * Event Payload Utilities
 *
 * Normalizes different event payload structures into consistent formats.
 * Handles variations in file_diff, create_file, edit_file_by_replace,
 * append_file, file_range_edit, insert_content_at_line, and read_file events.
 */
import { normalizeFunctionName } from "@src/lib/activityData/activityNormalizers";
import type { BackendEvent } from "@src/types/session/steps";
import { extractFilePathFromPayloads } from "@src/util/file/filePathPayload";

// ============================================
// Types
// ============================================

/**
 * Normalized file edit payload - consistent structure for all file edit events
 */
export interface NormalizedFileEdit {
  filePath: string;
  fileName: string;
  oldContent: string;
  newContent: string;
  isCreateFile: boolean;
  error?: string;
}

/**
 * Normalized file view payload - consistent structure for read_file events
 */
export interface NormalizedFileView {
  filePath: string;
  fileName: string;
  content: string;
  startLine?: number;
  endLine?: number;
  totalLines?: number;
  error?: string;
}

// ============================================
// File Edit Event Normalization
// ============================================

/**
 * Normalizes file edit event payloads into a consistent structure.
 *
 * Handles the following event types:
 * - file_diff: result has file path as key with JSON string value
 * - create_file: args.file_name, args.content, result.new_copy
 * - edit_file_by_replace: args.file_path, args.old_string, args.new_string
 * - append_file: args.file_path, args.content
 * - file_range_edit: args.file_path, args.start_line, args.end_line
 * - insert_content_at_line: args.file_path, args.line_number, args.content
 * - Nested activityData format: { activityData: { function, args, result } }
 *
 * @param event - The step event to normalize
 * @returns Normalized file edit data
 */
export function normalizeFileEditPayload(
  event: BackendEvent | Record<string, unknown>
): NormalizedFileEdit {
  // @ts-expect-error activityData is an optional nested wire field, not on BackendEvent's TS type
  const activityData = event.activityData;
  const rawFn = activityData?.function || event.function;
  const args = activityData?.args || event.args || {};
  const rawResult = activityData?.result || event.result;

  // Normalize function name (backend may send Edit, Write, etc.)
  const fnMap: Record<string, string> = {
    Edit: "edit_file_by_replace",
    EDIT: "edit_file_by_replace",
    edit: "edit_file_by_replace",
    MultiEdit: "edit_file_by_replace",
    Write: "create_file",
    WRITE: "create_file",
    write: "create_file",
  };
  const fn = fnMap[rawFn] || rawFn;

  // Handle backend format: result.output.success.diff
  let result = rawResult;
  if (rawResult?.output?.success) {
    const successData = rawResult.output.success;
    // Backend may return diff in output.success
    if (successData.diff) {
      result = {
        ...rawResult,
        file_path: successData.diff.path || successData.path,
        old_copy: successData.diff.old_text || "",
        new_copy: successData.diff.new_text || "",
      };
    } else if (successData.afterFullFileContent || successData.diffString) {
      // Backend Edit event format: afterFullFileContent is the new file content
      result = {
        ...rawResult,
        file_path: successData.path,
        old_copy: "", // No old content provided, will show as create
        new_copy: successData.afterFullFileContent || "",
        diffString: successData.diffString,
      };
    } else {
      result = {
        ...rawResult,
        ...successData,
      };
    }
  }

  // Handle file_diff with file path as result key
  if (fn === "file_diff" && result) {
    // Only treat as error if operation failed
    const diffHasError =
      result?.success === false || !!result?.error || !!result?.error_message;
    const diffError = diffHasError
      ? result?.error || result?.error_message
      : undefined;

    // Find the file path key (exclude internal keys starting with _)
    const keys = Object.keys(result).filter(
      (k) => !k.startsWith("_") && k !== "message"
    );

    if (keys.length > 0) {
      const filePath = keys[0];
      let data: { old_copy?: string; new_copy?: string } = {};

      // Parse JSON string if needed
      if (typeof result[filePath] === "string") {
        try {
          data = JSON.parse(result[filePath]);
        } catch {
          // If parsing fails, try to use as-is
          data = { new_copy: result[filePath] };
        }
      } else if (typeof result[filePath] === "object") {
        data = result[filePath];
      }

      return {
        filePath,
        fileName: extractFileName(filePath),
        oldContent: data.old_copy || args?.old_copy || "",
        newContent: data.new_copy || args?.new_copy || "",
        isCreateFile: false,
        error: diffError,
      };
    }

    // Fallback: try to get file_path from result directly
    if (result.file_path) {
      return {
        filePath: result.file_path,
        fileName: extractFileName(result.file_path),
        oldContent: result.old_copy || args?.old_copy || "",
        newContent: result.new_copy || args?.new_copy || "",
        isCreateFile: false,
        error: diffError,
      };
    }
  }

  // Handle create_file
  if (fn === "create_file") {
    const filePath =
      args?.file_name ||
      args?.file_path ||
      args?.path ||
      result?.file_path ||
      result?.path ||
      "";
    // Only treat as error if operation failed
    const createHasError =
      result?.success === false || !!result?.error || !!result?.error_message;
    return {
      filePath,
      fileName: extractFileName(filePath),
      oldContent: "",
      newContent:
        args?.content ||
        args?.new_copy ||
        result?.new_copy ||
        result?.content ||
        result?.afterFullFileContent ||
        args?.streamContent ||
        "",
      isCreateFile: true,
      error: createHasError
        ? result?.error || result?.error_message
        : undefined,
    };
  }

  // Handle edit_file_by_replace, append_file, file_range_edit, insert_content_at_line
  // File path can be in args.file_path, args.path, or result.file_path
  const filePath =
    args?.file_path ||
    args?.path ||
    args?.file_name ||
    result?.file_path ||
    result?.path ||
    "";

  // Get new content from various possible sources
  const newContent =
    result?.new_copy ||
    result?.afterFullFileContent ||
    args?.new_copy ||
    args?.new_string ||
    args?.content ||
    args?.new_content ||
    args?.streamContent || // Backend Edit event sends streamContent in args
    "";

  // Get old content - if not available, check if it's effectively a create
  const oldContent =
    result?.old_copy || args?.old_copy || args?.old_string || "";

  // Only treat as error if operation failed (success: false or has error/error_message)
  const hasError =
    result?.success === false ||
    !!result?.error ||
    !!result?.error_message ||
    !!rawResult?.error ||
    !!rawResult?.error_message;
  const errorMessage = hasError
    ? result?.error || result?.error_message || result?.message
    : undefined;

  return {
    filePath,
    fileName: extractFileName(filePath),
    oldContent,
    newContent,
    isCreateFile: !oldContent && !!newContent, // If no old content but has new, treat as create
    error: errorMessage,
  };
}

// ============================================
// File View Event Normalization
// ============================================

/**
 * Normalizes file view (read_file) event payloads into a consistent structure.
 *
 * Handles result formats:
 * - Direct: { content, start_line, end_line, total_lines }
 * - Timestamped: { [timestamp]: { content, ... } }
 * - Backend format: { output: { success: { content, ... } } }
 * - Nested activityData format: { activityData: { args, result } }
 *
 * @param event - The step event to normalize
 * @returns Normalized file view data
 */
export function normalizeFileViewPayload(
  event: BackendEvent | Record<string, unknown>
): NormalizedFileView {
  // @ts-expect-error activityData is an optional nested wire field, not on BackendEvent's TS type
  const activityData = event.activityData;
  const args = activityData?.args || event.args || {};
  const result = activityData?.result || event.result;

  const filePath = extractFilePathFromPayloads([args]);

  if (!result) {
    return {
      filePath,
      fileName: extractFileName(filePath),
      content: "",
    };
  }

  // Check for backend format: result.output.success.content
  let normalizedResult = result;

  // Handle backend Read event format: { output: { success: { content, ... } } }
  if (result?.output?.success) {
    normalizedResult = result.output.success;
  } else if (
    result?.success &&
    typeof result.success === "object" &&
    result.success.content
  ) {
    // Alternative format: { success: { content, ... } }
    normalizedResult = result.success;
  } else if (result && typeof result === "object" && !result.content) {
    // Check if result is timestamped format
    const keys = Object.keys(result).filter(
      (k) =>
        !k.startsWith("_") &&
        k !== "status" &&
        k !== "success" &&
        k !== "observation" &&
        k !== "output"
    );
    if (keys.length > 0) {
      // Get the latest timestamp entry
      const latestKey = keys[keys.length - 1];
      if (typeof result[latestKey] === "object") {
        normalizedResult = result[latestKey];
      }
    }
  }

  // Extract file path from result if not in args (some backends put it in result)
  const finalFilePath =
    filePath || extractFilePathFromPayloads([normalizedResult]);

  return {
    filePath: finalFilePath,
    fileName: extractFileName(finalFilePath),
    content: normalizedResult?.content || "",
    startLine: parseOptionalNumber(
      normalizedResult?.start_line || normalizedResult?.readRange?.startLine
    ),
    endLine: parseOptionalNumber(
      normalizedResult?.end_line || normalizedResult?.readRange?.endLine
    ),
    totalLines: parseOptionalNumber(
      normalizedResult?.total_lines || normalizedResult?.totalLines
    ),
    error: normalizedResult?.message || result?.message,
  };
}

// ============================================
// Search Event Normalization
// ============================================

export interface NormalizedSearchResult {
  query: string;
  directory?: string;
  results: SearchResultItem[];
  totalCount: number;
}

export interface SearchResultItem {
  filePath: string;
  matches: SearchMatch[];
}

export interface SearchMatch {
  lineNumber: number;
  content: string;
}

/**
 * Normalizes search event payloads (search_directory, search_codebase, codebase_search)
 * Also handles nested activityData format
 */
export function normalizeSearchPayload(
  event: BackendEvent | Record<string, unknown>
): NormalizedSearchResult {
  // @ts-expect-error activityData is an optional nested wire field, not on BackendEvent's TS type
  const activityData = event.activityData;
  const rawFn = activityData?.function || event.function;
  const args = activityData?.args || event.args || {};
  const rawResult = activityData?.result || event.result;

  // Normalize function name
  const fnMap: Record<string, string> = {
    Search: "codebase_search",
    Grep: "grep",
    GREP: "grep",
    Glob: "find_files",
    GLOB: "find_files",
  };
  const fn = fnMap[rawFn] || rawFn;

  // Handle backend format: result.output.success
  let result = rawResult;
  if (rawResult?.output?.success) {
    result = rawResult.output.success;
  }

  const baseResult: NormalizedSearchResult = {
    query: args?.query || args?.pattern || "",
    directory: args?.directory || args?.path,
    results: [],
    totalCount: 0,
  };

  if (!result) return baseResult;

  // Handle search result content field
  if (
    (fn === "codebase_search" || fn === "grep" || fn === "find_files") &&
    (result.content || result.observation)
  ) {
    const contentData = result.content || result.observation;
    try {
      const parsed =
        typeof contentData === "string" ? JSON.parse(contentData) : contentData;

      if (Array.isArray(parsed)) {
        baseResult.results = parsed.map((item: unknown) => {
          const itemObj = item as Record<string, unknown>;
          return {
            filePath: String(
              itemObj.name || itemObj.file_path || itemObj.path || ""
            ),
            matches: [
              {
                lineNumber: Number(itemObj.lineNumber || 0),
                content: String(itemObj.content || itemObj.match || ""),
              },
            ],
          };
        });
        baseResult.totalCount = parsed.length;
      }
    } catch {
      // If it's just a string observation, treat it as a single result
      if (typeof contentData === "string" && contentData.trim()) {
        baseResult.results = [
          { filePath: "", matches: [{ lineNumber: 0, content: contentData }] },
        ];
        baseResult.totalCount = 1;
      }
    }
    return baseResult;
  }

  // Handle search_directory and search_codebase
  const totalCount = parseInt(result._total_match_count || "0", 10);
  baseResult.totalCount = totalCount;

  // Extract file results (keys that aren't metadata)
  Object.entries(result).forEach(([key, value]) => {
    if (key.startsWith("_")) return;

    try {
      const matches = typeof value === "string" ? JSON.parse(value) : value;

      if (Array.isArray(matches)) {
        baseResult.results.push({
          filePath: key,
          matches: matches.map((m: unknown) => {
            const matchObj = m as Record<string, unknown>;
            return {
              lineNumber: Number(matchObj.lineNumber || 0),
              content: String(matchObj.content || ""),
            };
          }),
        });
      }
    } catch {
      // Skip unparseable entries
    }
  });

  return baseResult;
}

// ============================================
// Helper Functions
// ============================================

/**
 * Extracts file name from a file path
 */
export function extractFileName(filePath: string): string {
  if (!filePath) return "file";
  const parts = filePath.split("/");
  return parts[parts.length - 1] || filePath;
}

/**
 * Parses an optional number from string or number input
 */
function parseOptionalNumber(
  value: string | number | undefined
): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return value;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? undefined : parsed;
}

/**
 * Checks if an event is a file edit type.
 * Uses normalizeFunctionName to handle CLI tool aliases.
 */
export function isFileEditEvent(functionName: string): boolean {
  const normalized = normalizeFunctionName(functionName);
  return normalized === "edit_file";
}

/**
 * Checks if an event is a file view type.
 * Uses normalizeFunctionName to handle CLI tool aliases.
 */
export function isFileViewEvent(functionName: string): boolean {
  const normalized = normalizeFunctionName(functionName);
  return normalized === "read_file";
}

/**
 * Checks if an event is a search type.
 * Uses normalizeFunctionName to handle CLI tool aliases.
 * Also accepts legacy names for backward compatibility with tests.
 */
export function isSearchEvent(functionName: string): boolean {
  const normalized = normalizeFunctionName(functionName);
  // Canonical names
  if (
    normalized === "code_search" ||
    normalized === "glob_file_search" ||
    normalized === "grep_search" ||
    normalized === "list_dir"
  ) {
    return true;
  }
  // Legacy names (not in alias map but used in old events)
  const legacy = functionName.toLowerCase();
  return (
    legacy === "search_directory" ||
    legacy === "search_codebase" ||
    legacy === "codebase_search"
  );
}
