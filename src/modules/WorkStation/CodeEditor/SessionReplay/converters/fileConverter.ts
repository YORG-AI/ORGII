/**
 * File Operation Converter
 *
 * Converts SessionEvents into FileOperationEntry for the IDE simulator view.
 */
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import {
  extractEditData,
  extractFileData,
  stripLineNumberPrefixes,
} from "@src/engines/SessionCore/rendering/props";
import { APP_SUBTOOL } from "@src/engines/SessionCore/rendering/registry";
import { getAppSubtool } from "@src/engines/SessionCore/rendering/registry/initToolRegistry";
import { isDeleteTool } from "@src/engines/SessionCore/rendering/registry/toolRegistryDomain";
import type { EventStatus } from "@src/engines/SessionCore/rendering/types/universalProps";
import { getEventStatus } from "@src/util/data/converters/eventStatus";
import { shouldTrustDiffStartLines } from "@src/util/diff/startLines";
import { parseUnifiedDiff } from "@src/util/diff/unifiedDiff";

import {
  FILE_OPERATION_TYPE,
  type FileOperationEntry,
  type FileOperationType,
} from "../types";

export { shouldTrustDiffStartLines } from "@src/util/diff/startLines";

export function parseFilePath(path: string): {
  fileName: string;
  directory: string;
} {
  const parts = path.split("/");
  const fileName = parts.pop() || path;
  const directory = parts.join("/") || "/";
  return { fileName, directory };
}

/**
 * Convert a SessionEvent to a FileOperationEntry.
 * Returns null if the event is not a file operation.
 */
export function convertToFileOperation(
  event: SessionEvent,
  isCurrent: boolean
): FileOperationEntry | null {
  const eventType = event.functionName;
  const subtool = getAppSubtool(eventType);
  const isRead = subtool === APP_SUBTOOL.FILE_READ;
  const isWrite = subtool === APP_SUBTOOL.FILE_WRITE;

  if (!isRead && !isWrite) return null;

  const isDelete = isWrite && isDeleteTool(eventType);

  const type: FileOperationType = isDelete
    ? FILE_OPERATION_TYPE.DELETE
    : isRead
      ? FILE_OPERATION_TYPE.READ
      : FILE_OPERATION_TYPE.WRITE;

  const statusString = (getEventStatus(event) ||
    event.displayStatus) as EventStatus;

  const propsForExtraction = {
    eventId: event.id,
    eventType: event.functionName,
    args: event.args,
    result: event.result,
    status: statusString,
    variant: "simulator" as const,
    context: "simulator" as const,
    rustExtracted: event.extracted,
  };

  if (type === FILE_OPERATION_TYPE.DELETE) {
    const args = event.args || {};
    const filePath =
      (typeof args.path === "string" && args.path) ||
      (typeof args.file_path === "string" && args.file_path) ||
      (typeof args.target_file === "string" && args.target_file) ||
      "";
    if (!filePath) return null;

    const { fileName, directory } = parseFilePath(filePath);
    const ext = filePath.split(".").pop() || "text";

    return {
      filePath,
      fileName,
      directory,
      type: FILE_OPERATION_TYPE.DELETE,
      isLoading: statusString === "running" || statusString === "pending",
      isFailed: statusString === "failed",
      event,
      eventId: event.id,
      isCurrent,
      language: ext,
    };
  }

  if (type === FILE_OPERATION_TYPE.READ) {
    const data = extractFileData(propsForExtraction);
    if (!data.filePath) return null;

    const { fileName, directory } = parseFilePath(data.filePath);

    let content = data.content;
    let contentStartLine = data.startLine;
    if (!content) {
      const result = event.result || {};
      const output = result.output as Record<string, unknown> | undefined;

      const nestedSuccess = (output?.success as Record<string, unknown>) || {};
      let rawFallback: string | undefined = nestedSuccess?.content as
        | string
        | undefined;

      if (!rawFallback) {
        const directSuccess = (result.success as Record<string, unknown>) || {};
        rawFallback = directSuccess?.content as string | undefined;
      }

      if (!rawFallback && typeof output === "string") {
        rawFallback = output;
      }

      if (!rawFallback && typeof result.content === "string") {
        rawFallback = result.content as string;
      }

      if (!rawFallback && typeof result.file_content === "string") {
        rawFallback = result.file_content as string;
      }

      if (!rawFallback && typeof result.observation === "string") {
        rawFallback = result.observation as string;
      }

      if (rawFallback) {
        const stripped = stripLineNumberPrefixes(rawFallback);
        content = stripped.content;
        contentStartLine = stripped.startLine;
      }
    }

    return {
      filePath: data.filePath,
      fileName,
      directory,
      type: FILE_OPERATION_TYPE.READ,
      isLoading: statusString === "running" || statusString === "pending",
      isFailed: statusString === "failed",
      event,
      eventId: event.id,
      isCurrent,
      content,
      contentStartLine,
      language: data.language,
    };
  } else {
    const data = extractEditData(propsForExtraction);
    if (!data.filePath) return null;

    const { fileName, directory } = parseFilePath(data.filePath);
    const trustDiffStartLines = shouldTrustDiffStartLines(event);

    const parsedDiff = data.diff ? parseUnifiedDiff(data.diff) : null;
    let oldContent = parsedDiff?.oldValue ?? data.oldContent;
    let newContent = parsedDiff?.newValue ?? data.newContent;
    const oldStartLine = trustDiffStartLines
      ? (parsedDiff?.oldStartLine ?? data.oldStartLine)
      : undefined;
    const newStartLine = trustDiffStartLines
      ? (parsedDiff?.newStartLine ?? data.newStartLine)
      : undefined;
    if (!oldContent && !newContent) {
      const result = event.result || {};
      const args = event.args || {};
      const output = result.output as Record<string, unknown> | undefined;
      const successData = (output?.success as Record<string, unknown>) || {};

      oldContent = (successData?.beforeFullFileContent as string) || undefined;
      newContent = (successData?.afterFullFileContent as string) || undefined;

      if (!newContent) {
        newContent =
          (args?.new_str as string) ||
          (args?.new_string as string) ||
          (args?.new_content as string) ||
          undefined;
      }
      if (!oldContent) {
        oldContent =
          (args?.old_str as string) ||
          (args?.old_string as string) ||
          (args?.old_content as string) ||
          undefined;
      }
    }

    const writeHasBaselineContent = Boolean(
      oldContent && String(oldContent).length > 0
    );

    return {
      filePath: data.filePath,
      fileName,
      directory,
      type,
      isLoading: statusString === "running" || statusString === "pending",
      isFailed: statusString === "failed",
      event,
      eventId: event.id,
      isCurrent,
      oldContent,
      newContent,
      diff: data.diff,
      oldStartLine,
      newStartLine,
      writeHasBaselineContent,
      linesAdded: data.linesAdded,
      linesRemoved: data.linesRemoved,
      language: data.language,
    };
  }
}
