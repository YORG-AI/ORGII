/**
 * Explore Operation Converter
 *
 * Converts SessionEvents into ExploreOperationEntry for the IDE simulator view.
 * Handles code_search, grep, glob, list_dir, cat, manage_workspace, query_lsp events.
 *
 * Sub-modules:
 *  - exploreDataHelpers.ts   — primitive + text-parsing utilities
 *  - exploreResultExtractors.ts — per-tool result extractors
 *  - listDirParsers.ts        — list_dir specific parsers
 */
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import type { EventStatus } from "@src/engines/SessionCore/rendering/types/universalProps";
import { getEventStatus } from "@src/util/data/converters/eventStatus";

import type { ExploreOperationEntry, SearchResult } from "../types";
import { firstString } from "./exploreDataHelpers";
import {
  extractCatResults,
  extractGlobResults,
  extractLspResults,
  extractManageWorkspaceResults,
  extractSearchResults,
} from "./exploreResultExtractors";
import { isExplorePanelTool, resolveExploreType } from "./exploreTypeResolver";
import { extractListDirResults } from "./listDirParsers";

// ============================================
// Argument Source Helpers
// ============================================

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nestedArgSources(
  args: Record<string, unknown>,
  result: Record<string, unknown>
): Record<string, unknown>[] {
  return [
    args,
    asRecord(args.input),
    asRecord(args.params),
    asRecord(args.arguments),
    asRecord(args.tool_input),
    asRecord(args.toolInput),
    asRecord(result.args),
    asRecord(result.input),
    asRecord(result.params),
  ].filter((source): source is Record<string, unknown> => Boolean(source));
}

function firstStringFromSources(
  sources: Record<string, unknown>[],
  keys: string[]
): string {
  for (const source of sources) {
    const value = firstString(source, keys);
    if (value) return value;
  }
  return "";
}

// ============================================
// Slim Event (strip large payload fields)
// ============================================

function hasResultPayload(result: Record<string, unknown>): boolean {
  return Object.keys(result).length > 0;
}

function extractToolSearchResults(result: Record<string, unknown>): string[] {
  const textSources = [
    result.output,
    result.content,
    result.observation,
  ].filter(
    (source): source is string =>
      typeof source === "string" && source.trim().length > 0
  );

  for (const text of textSources) {
    const toolNames = text
      .split("\n")
      .map((line) =>
        line
          .trim()
          .match(/^\*\*([^*]+)\*\*/)?.[1]
          ?.trim()
      )
      .filter((toolName): toolName is string => Boolean(toolName));
    if (toolNames.length > 0) return toolNames;
  }

  return [];
}

export function toSlimExploreEvent(event: SessionEvent): SessionEvent {
  const argsCallId =
    typeof event.args?.call_id === "string" ? event.args.call_id : undefined;
  const resultCallId =
    typeof event.result?.call_id === "string"
      ? event.result.call_id
      : undefined;

  return {
    ...event,
    callId: event.callId || argsCallId || resultCallId,
    args: {},
    result: {},
    extracted: undefined,
    filePath: undefined,
    command: undefined,
  };
}

// ============================================
// Query / Directory Resolution
// ============================================

function extractQueryAndDirectory(
  exploreType: string,
  args: Record<string, unknown>,
  result: Record<string, unknown>
): { query: string; directory: string | undefined } {
  const argSources = nestedArgSources(args, result);

  if (exploreType === "tool_search") {
    return {
      query: firstStringFromSources(argSources, ["query"]),
      directory: undefined,
    };
  }

  if (exploreType === "list_dir") {
    const directory =
      firstStringFromSources(argSources, [
        "target_directory",
        "targetDirectory",
        "path",
        "dir",
        "file_path",
      ]) || ".";
    return { query: `ls ${directory}`, directory };
  }

  // manage_workspace and query_lsp don't carry a meaningful "query" string —
  // the sidebar derives its label/arg from the event via `formatToolName` +
  // `formatToolArg`. Keep `query` empty so no stale translation key leaks
  // into the UI; downstream panels that want the raw action/path should
  // read `event.args` directly.
  if (exploreType === "manage_workspace" || exploreType === "query_lsp") {
    return { query: "", directory: undefined };
  }

  if (exploreType === "cat") {
    const filePath = firstStringFromSources(argSources, [
      "file_path",
      "target_file",
      "path",
    ]);
    return {
      query: `cat ${filePath}`,
      directory: filePath.split("/").slice(0, -1).join("/") || "/",
    };
  }

  const output = result.output as Record<string, unknown> | undefined;
  const success = output?.success as Record<string, unknown> | undefined;

  const query =
    firstStringFromSources(argSources, [
      "query",
      "pattern",
      "glob_pattern",
      "globPattern",
      "search_query",
      "searchQuery",
      "explanation",
    ]) ||
    firstString(success || {}, [
      "pattern",
      "query",
      "search_query",
      "searchQuery",
    ]);

  const targetDirectoryList = argSources.find((source) =>
    Array.isArray(source.target_directories)
  )?.target_directories;
  const directory =
    firstStringFromSources(argSources, [
      "target_directory",
      "targetDirectory",
      "directory",
      "dir",
      "repo_path",
      "repoPath",
      "path",
    ]) ||
    (Array.isArray(targetDirectoryList)
      ? targetDirectoryList
          .filter((item) => typeof item === "string")
          .join(", ")
      : "") ||
    firstString(success || {}, [
      "path",
      "directory",
      "repo_path",
      "repoPath",
    ]) ||
    undefined;

  return { query, directory };
}

// ============================================
// Public Entry Point
// ============================================

/**
 * Convert a SessionEvent to an ExploreOperationEntry.
 * Returns null if the event is not an explore operation.
 */
export function convertToExploreOperation(
  event: SessionEvent,
  isCurrent: boolean
): ExploreOperationEntry | null {
  const eventType = event.functionName;

  if (!isExplorePanelTool(eventType)) return null;

  const args = asRecord(event.args) ?? {};
  const result = asRecord(event.result) ?? {};

  const statusString = getEventStatus(event) as EventStatus | undefined;
  const effectiveStatus = statusString || event.displayStatus;
  const action =
    firstStringFromSources(nestedArgSources(args, result), ["action"]) ||
    undefined;
  const exploreType = resolveExploreType(eventType, action);
  const { query, directory } = extractQueryAndDirectory(
    exploreType,
    args,
    result
  );

  let results: SearchResult[] = [];
  let files: string[] = [];
  let totalMatches = 0;
  let listDirDisplayTruncated: boolean | undefined;
  let listDirTotalListedCount: number | undefined;
  let listDirParseSafetyCapped: boolean | undefined;

  if (exploreType === "list_dir") {
    const listDirData = extractListDirResults(result);
    files = listDirData.files;
    totalMatches = files.length;
    listDirDisplayTruncated = listDirData.listDirDisplayTruncated;
    listDirTotalListedCount = listDirData.listDirTotalListedCount;
    listDirParseSafetyCapped = listDirData.listDirParseSafetyCapped;
  } else if (exploreType === "tool_search") {
    files = extractToolSearchResults(result);
    totalMatches = files.length;
  } else if (exploreType === "manage_workspace") {
    const workspacesData = extractManageWorkspaceResults(result);
    files = workspacesData.files;
    totalMatches = workspacesData.totalMatches;
  } else if (exploreType === "query_lsp") {
    const lspData = extractLspResults(args, result);
    results = lspData.results;
    files = lspData.files;
    totalMatches = lspData.totalMatches;
  } else if (exploreType === "cat") {
    const catData = extractCatResults(args, result);
    results = catData.results;
    totalMatches = catData.totalMatches;
  } else if (exploreType === "glob" || exploreType === "file_search") {
    const globData = extractGlobResults(event, result);
    files = globData.files;
    totalMatches = globData.totalMatches;
  } else {
    const searchData = extractSearchResults(event, result);
    results = searchData.results;
    files = searchData.files;
    totalMatches = searchData.totalMatches;
  }

  if (typeof result.total_matches === "number") {
    totalMatches = result.total_matches;
  } else if (typeof result.count === "number") {
    totalMatches = result.count;
  }

  return {
    query,
    exploreType,
    exploreAction: action,
    results,
    files,
    totalMatches,
    hasResultPayload: hasResultPayload(result),
    directory,
    event: toSlimExploreEvent(event),
    eventId: event.id,
    isCurrent,
    isLoading: effectiveStatus === "running" || effectiveStatus === "pending",
    isFailed: effectiveStatus === "failed",
    ...(exploreType === "list_dir"
      ? {
          listDirDisplayTruncated,
          listDirTotalListedCount,
          listDirParseSafetyCapped,
        }
      : {}),
  };
}
