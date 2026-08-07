const THOUGHT_PREVIEW_MAX_LENGTH = 96;

/** Convert Markdown reasoning into compact plain text for the header subtitle. */
export function stripMarkdownForThoughtPreview(content: string): string {
  return content
    .replace(/^\s*```[^\n]*$/gm, "")
    .replace(/!\[([^\]]*)\]\((?:\\.|[^)])*\)/g, "$1")
    .replace(/\[([^\]]+)\]\((?:\\.|[^)])*\)/g, "$1")
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1")
    .replace(/<((?:https?:\/\/|mailto:)[^>]+)>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/^\s{0,3}#{1,6}[\t ]+/gm, "")
    .replace(/^\s{0,3}>[\t ]?/gm, "")
    .replace(/^\s{0,3}(?:[-+*]|\d+[.)])[\t ]+/gm, "")
    .replace(/^\s*\[[ xX]\][\t ]+/gm, "")
    .replace(/(`+)([\s\S]*?)\1/g, "$2")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
    .replace(/\*(?=\S)([^*\n]*?\S)\*/g, "$1")
    .replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?!\w)/gm, "$1$2")
    .replace(/\\([\\`*_[\]{}()#+.!>|~-])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function getThoughtPreview(content?: string): string | null {
  if (!content) return null;

  const plainText = stripMarkdownForThoughtPreview(content);
  if (!plainText) return null;
  if (plainText.length <= THOUGHT_PREVIEW_MAX_LENGTH) return plainText;
  return `${plainText.slice(0, THOUGHT_PREVIEW_MAX_LENGTH).trimEnd()}...`;
}
