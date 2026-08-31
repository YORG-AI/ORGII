const WRITING_BLOCK_OPEN = /^\s*:::writing(?:\{[^\r\n]*\})?\s*$/;
const WRITING_BLOCK_CLOSE = /^\s*:::\s*$/;
const WRITING_BLOCK_TONE = /^\s*---tone\s+(.+?)\s*$/;

/**
 * Project app-level writing blocks into ordinary Markdown for chat surfaces
 * that do not provide the host application's interactive writing-block UI.
 * Unrelated Markdown directives are preserved verbatim.
 */
export function normalizeAssistantMessageText(text: string): string {
  if (!text.includes(":::writing")) return text;

  const lines = text.split(/\r?\n/);
  const output: string[] = [];
  let insideWritingBlock = false;
  let changed = false;

  for (const line of lines) {
    if (!insideWritingBlock && WRITING_BLOCK_OPEN.test(line)) {
      insideWritingBlock = true;
      changed = true;
      continue;
    }
    if (insideWritingBlock && WRITING_BLOCK_CLOSE.test(line)) {
      insideWritingBlock = false;
      changed = true;
      continue;
    }
    if (insideWritingBlock) {
      const tone = line.match(WRITING_BLOCK_TONE);
      if (tone) {
        output.push(`#### ${tone[1]}`);
        changed = true;
        continue;
      }
    }
    output.push(line);
  }

  if (!changed) return text;
  return output
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
