import type { FileError } from "./types";

function extractErrorReason(raw: string): string {
  const withErrorMatch = raw.match(/with error:\s*(.+)/i);
  if (withErrorMatch) {
    return withErrorMatch[1].trim();
  }

  const colonParts = raw.split(":");
  if (colonParts.length > 1) {
    return colonParts[colonParts.length - 1].trim();
  }

  return raw;
}

export function classifyFileError(raw: string): FileError {
  const lower = raw.toLowerCase();

  if (
    lower.includes("no such file") ||
    lower.includes("not found") ||
    lower.includes("enoent")
  ) {
    return {
      type: "not_found",
      message: "File not found. It may have been deleted or moved.",
    };
  }

  if (
    lower.includes("permission") ||
    lower.includes("forbidden") ||
    lower.includes("access denied") ||
    lower.includes("eacces")
  ) {
    return {
      type: "permission",
      message:
        "Permission denied. The file cannot be read due to access restrictions.",
    };
  }

  if (lower.includes("is a directory")) {
    return {
      type: "not_found",
      message: "Path is a directory, not a file.",
    };
  }

  return {
    type: "unknown",
    message: extractErrorReason(raw),
  };
}
