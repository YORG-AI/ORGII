/**
 * File card parser — derives structured card data from file tool calls.
 */
import type { FileCardData } from "../../types";

function getFileExt(filePath: string): string {
  const base = filePath.split("/").pop() ?? filePath;
  const dotIdx = base.lastIndexOf(".");
  if (dotIdx <= 0) return "";
  return base.substring(dotIdx + 1).toLowerCase();
}

export function parseFileCardResult(
  args: Record<string, unknown>,
  result: Record<string, unknown>
): FileCardData | null {
  const rawPath =
    (typeof args.path === "string" ? args.path : null) ??
    (typeof args.file_path === "string" ? args.file_path : null) ??
    (typeof result.path === "string" ? result.path : null);
  if (!rawPath) return null;

  const name = rawPath.split("/").pop() ?? rawPath;
  const ext = getFileExt(rawPath);

  const rawSize = result.size_bytes ?? result.sizeBytes ?? args.size_bytes;
  const sizeBytes =
    typeof rawSize === "number" && rawSize >= 0 ? rawSize : undefined;

  return { path: rawPath, name, ext, sizeBytes };
}
