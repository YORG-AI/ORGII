const WRITING_BLOCK_OPEN = /^\s*:::writing(?:\{([^}\r\n]*)\})?\s*$/;
const WRITING_BLOCK_CLOSE = /^\s*:::\s*$/;
const WRITING_BLOCK_TONE = /^\s*---tone\s+(.+?)\s*$/;
const PORTABLE_WRITING_VARIANTS = new Set(["chat_message", "standard"]);

function resolveWritingBlockVariant(
  attributes: string | undefined
): string | null {
  if (!attributes) return null;
  const match = attributes.match(/variant\s*=\s*["']([^"']+)["']/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function isPortableWritingVariant(variant: string | null): boolean {
  return variant == null || PORTABLE_WRITING_VARIANTS.has(variant);
}

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
  let emitWritingBlockContent = true;
  let changed = false;

  for (const line of lines) {
    const openingMatch = !insideWritingBlock
      ? line.match(WRITING_BLOCK_OPEN)
      : null;
    if (openingMatch) {
      insideWritingBlock = true;
      emitWritingBlockContent = isPortableWritingVariant(
        resolveWritingBlockVariant(openingMatch[1])
      );
      changed = true;
      continue;
    }
    if (insideWritingBlock && WRITING_BLOCK_CLOSE.test(line)) {
      insideWritingBlock = false;
      emitWritingBlockContent = true;
      changed = true;
      continue;
    }
    if (insideWritingBlock) {
      if (!emitWritingBlockContent) {
        changed = true;
        continue;
      }
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
