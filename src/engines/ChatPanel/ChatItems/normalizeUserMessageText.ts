import { serializePillNode } from "@src/components/ComposerInput/utils";
import { imageRefToRustPath } from "@src/util/file/imageRefs";

const FILES_MENTIONED_HEADING = /^#{1,6}\s+Files mentioned by the user:\s*$/i;
const MY_REQUEST_HEADING = /^#{1,6}\s+My request for Codex:\s*$/i;
const FILE_ENTRY_HEADING =
  /^#{2,6}\s+(.+):\s+((?:\/|[a-z]:[\\/]|\\\\|file:\/\/).+)$/i;

function normalizeLine(line: string): string {
  return line.trim().replace(/^[\u200B\uFEFF]+/, "");
}

function fileEntryPill(line: string): string | null {
  const match = normalizeLine(line).match(FILE_ENTRY_HEADING);
  if (!match) return null;

  const displayName = match[1].trim();
  const path = match[2].trim();
  const isFolder = path.endsWith("/") || path.endsWith("\\");
  return serializePillNode({
    filePath: path,
    fileName: displayName,
    iconType: isFolder ? "folder" : "file",
  });
}

/**
 * Normalizes Codex's generated attachment envelope into native ORGII history
 * text. File entries become serialized file/folder pills, while the injected
 * "Files mentioned" and "My request" headings are removed.
 */
export function normalizeUserMessageText(
  text: string,
  imageRefs: readonly string[] = []
): string {
  const imagePaths = new Set(imageRefs.map(imageRefToRustPath));
  const lines = text.split(/\r?\n/);
  const firstContentLineIndex = lines.findIndex(
    (line) => normalizeLine(line).length > 0
  );
  if (firstContentLineIndex < 0) return "";

  const firstContentLine = normalizeLine(lines[firstContentLineIndex] ?? "");
  if (!FILES_MENTIONED_HEADING.test(firstContentLine ?? "")) return text;

  const remainder = lines.slice(firstContentLineIndex + 1).map((line) => {
    if (MY_REQUEST_HEADING.test(normalizeLine(line))) return "";
    const pill = fileEntryPill(line);
    if (!pill) return line;
    const path = normalizeLine(line).match(FILE_ENTRY_HEADING)?.[2]?.trim();
    return path && imagePaths.has(path) ? "" : pill;
  });

  const normalized = remainder
    .join("\n")
    .replace(/^(?:[ \t]*\n)+/, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  return normalized.trim() ? normalized : "";
}
