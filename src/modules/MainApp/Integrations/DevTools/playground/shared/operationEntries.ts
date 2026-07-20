import { invoke } from "@tauri-apps/api/core";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { extractApplyPatchDataFromRust } from "@src/engines/SessionCore/rendering/props/propsDataExtractors";
import { getAppSubtool } from "@src/engines/SessionCore/rendering/registry/initToolRegistry";
import { isDeleteTool } from "@src/engines/SessionCore/rendering/registry/toolRegistryDomain";
import type { RustPatchConversionResult } from "@src/engines/SessionCore/rendering/types/universalProps";
import {
  isExplorePanelTool,
  resolveExploreType,
} from "@src/modules/WorkStation/CodeEditor/SessionReplay/converters/exploreTypeResolver";
import { parseFilePath } from "@src/modules/WorkStation/CodeEditor/SessionReplay/converters/fileConverter";
import type {
  ExploreOperationEntry,
  FileOperationEntry,
  FileOperationType,
  ShellOperationEntry,
} from "@src/modules/WorkStation/CodeEditor/SessionReplay/types";
import { parseUnifiedDiffToOldNew } from "@src/util/diff/unifiedDiff";

export type OperationType = "file" | "shell" | "explore" | "unknown";

export function getOperationType(functionName: string): OperationType {
  if (isExplorePanelTool(functionName)) return "explore";
  const subtool = getAppSubtool(functionName);
  if (subtool === "file_read" || subtool === "file_write") return "file";
  if (subtool === "shell") return "shell";
  return "unknown";
}

/**
 * File sidebar entries for the playground simulator. apply_patch expands to one
 * entry per patch segment (each Add/Modify File section) via Rust backend.
 */
export async function buildFileOperationsFromEvent(
  event: SessionEvent
): Promise<FileOperationEntry[]> {
  if (event.functionName === "apply_patch") {
    const args = event.args;
    const patchText = args.patch_text;
    if (typeof patchText !== "string" || !patchText) return [];

    const rustResult = await invoke<RustPatchConversionResult>(
      "es_convert_patch_to_diff",
      { patchText }
    );

    const result = event.result;
    const editData = extractApplyPatchDataFromRust(rustResult, result);
    const segments = editData.applyPatchSegments;
    if (!segments?.length) return [];

    return segments.map((segment, index) => {
      const { directory } = parseFilePath(segment.filePath);

      if (segment.isDeleted) {
        return {
          filePath: segment.filePath,
          fileName: segment.fileName,
          directory,
          type: "delete" as const,
          event,
          eventId: `${event.id}::patch::${index}`,
          isCurrent: index === 0,
          language: segment.language,
        };
      }

      const { oldValue, newValue } = segment.diff
        ? parseUnifiedDiffToOldNew(segment.diff)
        : { oldValue: "", newValue: segment.newContent ?? "" };
      return {
        filePath: segment.filePath,
        fileName: segment.fileName,
        directory,
        type: "write" as const,
        event,
        eventId: `${event.id}::patch::${index}`,
        isCurrent: index === 0,
        oldContent: oldValue,
        newContent: newValue,
        linesAdded: segment.linesAdded,
        linesRemoved: segment.linesRemoved,
        language: segment.language,
      };
    });
  }
  const single = eventToFileOperation(event);
  return single ? [single] : [];
}

export function eventToFileOperation(
  event: SessionEvent
): FileOperationEntry | null {
  const args = event.args;
  const result = event.result;
  const filePath = (args?.file_path as string) || (args?.path as string) || "";
  if (!filePath) return null;

  const { fileName, directory } = parseFilePath(filePath);

  const subtool = getAppSubtool(event.functionName);
  const isDelete = subtool === "file_write" && isDeleteTool(event.functionName);
  const type: FileOperationType = isDelete
    ? "delete"
    : subtool === "file_write"
      ? "write"
      : "read";

  return {
    filePath,
    fileName,
    directory,
    type,
    event,
    eventId: event.id,
    isCurrent: true,
    isFailed: event.displayStatus === "failed",
    content: (result?.content as string) || undefined,
    oldContent: (result?.old_content as string) || undefined,
    newContent: (result?.new_content as string) || undefined,
    linesAdded: (result?.lines_added as number) || undefined,
    linesRemoved: (result?.lines_removed as number) || undefined,
  };
}

export function eventToShellOperation(
  event: SessionEvent
): ShellOperationEntry | null {
  const args = event.args;
  const result = event.result;
  const command = (args?.command as string) || "";
  if (!command) return null;

  const shortCommand = command.split(/\s+/).slice(0, 3).join(" ");

  return {
    command,
    shortCommand,
    commandKeywords: shortCommand,
    output:
      (result?.output as string) || (result?.content as string) || undefined,
    exitCode: (result?.exit_code as number) || undefined,
    cwd: (args?.cwd as string) || undefined,
    isLoading: event.displayStatus === "running",
    isFailed: event.displayStatus === "failed",
    event,
    eventId: event.id,
    isCurrent: true,
  };
}

export function eventToExploreOperation(
  event: SessionEvent
): ExploreOperationEntry | null {
  const args = event.args;
  const result = event.result;

  const action =
    typeof args?.action === "string" ? (args.action as string) : undefined;
  const exploreType = resolveExploreType(event.functionName, action);
  const query =
    (args?.pattern as string) ||
    (args?.query as string) ||
    (args?.search_term as string) ||
    (args?.target_directory as string) ||
    (args?.path as string) ||
    "";

  // list_dir: convert entries array → string[] (dirs with "/" suffix, files plain)
  let files: string[] = (result?.files as string[]) || [];
  if (exploreType === "list_dir" && files.length === 0) {
    const rawEntries =
      (result?.entries as Array<Record<string, unknown>>) || [];
    if (Array.isArray(rawEntries) && rawEntries.length > 0) {
      files = rawEntries.map((entry) => {
        const name = (entry.name as string) || "";
        const isDir =
          entry.is_directory || entry.isDirectory || entry.type === "directory";
        return isDir ? `${name}/` : name;
      });
    }
  }

  if (exploreType === "tool_search" && files.length === 0) {
    const content =
      (result?.output as string) ||
      (result?.content as string) ||
      (result?.observation as string) ||
      "";
    files = content
      .split("\n")
      .map((line) =>
        line
          .trim()
          .match(/^\*\*([^*]+)\*\*/)?.[1]
          ?.trim()
      )
      .filter((toolName): toolName is string => Boolean(toolName));
  }

  // manage_workspace: parse "[git] name → path" lines from content string
  // (shared across list / add / remove actions)
  if (exploreType === "manage_workspace" && files.length === 0) {
    const content = (result?.content as string) || "";
    if (content && content.includes("→")) {
      files = content
        .split("\n")
        .filter((line) => line.includes("→"))
        .map((line) => {
          const kindMatch = line.match(/^\[(\w+)\]\s*/);
          const kind = kindMatch?.[1] || "git";
          const rest = kindMatch ? line.slice(kindMatch[0].length) : line;
          const [name, ...pathParts] = rest.split("→");
          return `[${kind}] ${name.trim()} → ${pathParts.join("→").trim()}`;
        });
    }
  }

  // query_lsp: convert structured results to SearchResult rows
  let exploreResults: ExploreOperationEntry["results"] =
    (result?.results as ExploreOperationEntry["results"]) || [];

  if (exploreType === "query_lsp" && exploreResults.length === 0) {
    const diagnostics =
      (result?.diagnostics as Array<Record<string, unknown>>) || [];
    if (diagnostics.length > 0) {
      exploreResults = diagnostics.map((diag, idx) => ({
        file: (diag.file as string) || (args?.file_path as string) || "",
        line: (diag.line as number) || idx + 1,
        content: (diag.message as string) || (diag.content as string) || "",
      }));
    }
    const content =
      (result?.content as string) || (result?.output as string) || "";
    if (exploreResults.length === 0 && content) {
      exploreResults = content
        .split("\n")
        .filter((line) => line.trim())
        .map((line, idx) => ({
          file: (args?.file_path as string) || "",
          line: idx + 1,
          content: line,
        }));
    }
  }

  // web_search: convert { title, url, snippet } → SearchResult { file, line, content }
  if (event.functionName === "web_search" && Array.isArray(result?.results)) {
    exploreResults = (result.results as Array<Record<string, unknown>>).map(
      (item, idx) => ({
        file: (item.url as string) || (item.title as string) || `result-${idx}`,
        line: idx + 1,
        content:
          `${item.title ?? ""}\n${item.snippet ?? item.description ?? ""}`.trim(),
      })
    );
  }

  return {
    query,
    exploreType,
    results: exploreResults,
    files,
    totalMatches:
      (result?.total_matches as number) ||
      exploreResults.length ||
      files.length,
    directory:
      (args?.target_directory as string) || (args?.path as string) || undefined,
    isLoading: event.displayStatus === "running",
    isFailed: event.displayStatus === "failed",
    event,
    eventId: event.id,
    isCurrent: true,
  };
}
