const FILES_MENTIONED_HEADING = /^#{1,6}\s+Files mentioned by the user:\s*$/i;

/**
 * Removes the injected file-section heading from the start of a user message.
 * When the section has no entries or request text, this returns an empty string
 * so the history does not render a heading-only bubble.
 */
export function normalizeUserMessageText(text: string): string {
  const lines = text.split(/\r?\n/);
  const normalizeLine = (line: string) =>
    line.trim().replace(/^[\u200B\uFEFF]+/, "");
  const firstContentLineIndex = lines.findIndex(
    (line) => normalizeLine(line).length > 0
  );
  if (firstContentLineIndex < 0) return "";

  const firstContentLine = normalizeLine(lines[firstContentLineIndex] ?? "");
  if (!FILES_MENTIONED_HEADING.test(firstContentLine ?? "")) return text;

  const remainder = lines
    .slice(firstContentLineIndex + 1)
    .join("\n")
    .replace(/^(?:[ \t]*\n)+/, "");
  return remainder.trim() ? remainder : "";
}
