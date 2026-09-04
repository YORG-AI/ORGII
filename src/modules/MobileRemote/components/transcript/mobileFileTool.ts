import type {
  MobileToolData,
  TranscriptItem,
} from "../../lib/transcriptReducer";

export interface MobileFileTarget {
  /** Stable index into the authoritative event's file targets. */
  targetIndex: number;
  filePath: string;
  fileName: string;
  language?: string;
  line?: number;
  content?: string;
  diff?: string;
  linesAdded?: number;
  linesRemoved?: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : undefined;
}

function fileNameFromPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").pop() || filePath;
}

function targetFromRecord(
  value: Record<string, unknown>,
  fallbackPath: string | undefined,
  targetIndex: number
): MobileFileTarget | null {
  const filePath = stringValue(value.filePath) ?? fallbackPath;
  if (!filePath) return null;

  return {
    targetIndex,
    filePath,
    fileName: stringValue(value.fileName) ?? fileNameFromPath(filePath),
    language: stringValue(value.language),
    line:
      numberValue(value.newStartLine) ??
      numberValue(value.startLine) ??
      numberValue(value.oldStartLine),
    content:
      textValue(value.newContent) ??
      textValue(value.content) ??
      textValue(value.oldContent),
    diff: textValue(value.diff),
    linesAdded: numberValue(value.linesAdded),
    linesRemoved: numberValue(value.linesRemoved),
  };
}

function dedupeTargets(targets: MobileFileTarget[]): MobileFileTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.targetIndex}\u0000${target.filePath}\u0000${target.line ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Project the same Rust `ExtractedData` file/edit payload consumed by Desktop
 * into the browser-safe target shape used by Mobile Remote.
 */
export function mobileFileTargets(item: TranscriptItem): MobileFileTarget[] {
  const payload = record(item.toolData as MobileToolData | undefined);
  const fallbackPath = stringValue(item.toolFilePath);
  if (!payload) {
    const fallback = fallbackPath
      ? targetFromRecord({}, fallbackPath, 0)
      : null;
    return fallback ? [fallback] : [];
  }

  const kind = stringValue(payload.kind);
  if (
    !fallbackPath &&
    kind !== "file" &&
    kind !== "edit" &&
    kind !== "deleteFile"
  ) {
    return [];
  }

  const segments = Array.isArray(payload.applyPatchSegments)
    ? payload.applyPatchSegments
        .map(record)
        .filter((segment): segment is Record<string, unknown> =>
          Boolean(segment)
        )
        .map((segment, targetIndex) =>
          targetFromRecord(segment, undefined, targetIndex)
        )
        .filter((target): target is MobileFileTarget => Boolean(target))
    : [];
  if (segments.length > 0) return dedupeTargets(segments);

  const target = targetFromRecord(payload, fallbackPath, 0);
  return target ? [target] : [];
}
