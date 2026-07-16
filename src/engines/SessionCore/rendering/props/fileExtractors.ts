/**
 * File read data extractor.
 */
import {
  FILE_NAME_PAYLOAD_KEYS,
  extractFilePathFromPayloads,
  readPayloadString,
} from "@src/util/file/filePathPayload";
import { getFileName } from "@src/util/file/pathUtils";

import type {
  ExtractedFileData,
  UniversalEventProps,
} from "../types/universalProps";
import {
  detectLanguage,
  extractSuccessData,
  safeText,
  stripLineNumberPrefixes,
} from "./extractorShared";

function payloadNumber(
  payload: Record<string, unknown> | undefined,
  key: string
): number | undefined {
  const value = payload?.[key];
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  return undefined;
}

function readLineMetadata(args: UniversalEventProps["args"]): {
  startLine?: number;
  lineCount?: number;
} {
  const offset = payloadNumber(args, "offset");
  const limit = payloadNumber(args, "limit");
  if (limit === undefined) return {};
  return {
    startLine: offset !== undefined ? offset + 1 : undefined,
    lineCount: limit,
  };
}

export function extractFileData(props: UniversalEventProps): ExtractedFileData {
  const metadata = readLineMetadata(props.args);

  if (props.rustExtracted?.kind === "file" && props.rustExtracted.filePath) {
    const { filePath, fileName, content, language } = props.rustExtracted;
    const stripped = content ? stripLineNumberPrefixes(content) : undefined;
    const startLine =
      stripped?.startLine ??
      props.rustExtracted.startLine ??
      metadata.startLine;
    const hasNumberedStart =
      stripped?.startLine !== undefined ||
      props.rustExtracted.startLine !== undefined;
    const lineCount = hasNumberedStart
      ? (stripped?.lineCount ?? props.rustExtracted.lineCount)
      : (metadata.lineCount ??
        props.rustExtracted.lineCount ??
        stripped?.lineCount);
    return {
      filePath,
      fileName,
      content: stripped?.content,
      language,
      lineCount,
      startLine,
    };
  }

  const { args, result } = props;
  const successData = extractSuccessData(result);

  const filePath =
    extractFilePathFromPayloads([args, successData, result]) ||
    props.filePath ||
    "";
  const directFileName =
    readPayloadString(args, FILE_NAME_PAYLOAD_KEYS) ??
    readPayloadString(successData, FILE_NAME_PAYLOAD_KEYS) ??
    readPayloadString(result, FILE_NAME_PAYLOAD_KEYS);

  const fileName = filePath ? getFileName(filePath) : directFileName || "";

  const rawContent =
    (successData?.content as string) ||
    safeText(result?.output) ||
    safeText(result?.content) ||
    safeText(result?.file_content) ||
    safeText(result?.observation) ||
    undefined;

  const stripped = rawContent ? stripLineNumberPrefixes(rawContent) : undefined;
  const content = stripped?.content;
  const startLine = stripped?.startLine ?? metadata.startLine;
  const lineCount =
    stripped?.startLine !== undefined
      ? stripped.lineCount
      : (metadata.lineCount ?? stripped?.lineCount);

  const language = detectLanguage(fileName);

  return { filePath, fileName, content, language, lineCount, startLine };
}
