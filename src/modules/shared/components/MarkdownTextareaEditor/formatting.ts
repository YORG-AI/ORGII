export type MarkdownTextareaFormat =
  | "heading"
  | "bold"
  | "italic"
  | "strikethrough"
  | "inlineCode"
  | "link"
  | "quote"
  | "bulletList"
  | "numberedList"
  | "taskList";

export interface MarkdownTextareaSelection {
  value: string;
  start: number;
  end: number;
}

export interface MarkdownTextareaEdit {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

/** Convert Markdown source to the plain-text callback shape used by projects. */
export function markdownTextareaToPlainText(markdown: string): string {
  return markdown
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
    .replace(/[\t ]+$/gm, "")
    .trim();
}

/** Insert plain source text after the active selection without deleting it. */
export function insertMarkdownTextareaText(
  selection: MarkdownTextareaSelection,
  text: string,
  separateFromAdjacentText = false
): MarkdownTextareaEdit {
  const { value, end } = normalizedSelection(selection);
  const before = value.slice(0, end);
  const after = value.slice(end);
  const leadingSpace =
    separateFromAdjacentText && before.length > 0 && !/\s$/u.test(before)
      ? " "
      : "";
  const trailingSpace =
    separateFromAdjacentText && after.length > 0 && !/^\s/u.test(after)
      ? " "
      : "";
  const inserted = `${leadingSpace}${text}${trailingSpace}`;
  const caret = end + inserted.length;
  return {
    value: `${before}${inserted}${after}`,
    selectionStart: caret,
    selectionEnd: caret,
  };
}

function normalizedSelection({
  value,
  start,
  end,
}: MarkdownTextareaSelection): MarkdownTextareaSelection {
  const boundedStart = Math.max(0, Math.min(start, value.length));
  const boundedEnd = Math.max(0, Math.min(end, value.length));
  return {
    value,
    start: Math.min(boundedStart, boundedEnd),
    end: Math.max(boundedStart, boundedEnd),
  };
}

function surroundSelection(
  selection: MarkdownTextareaSelection,
  prefix: string,
  suffix: string,
  placeholder: string
): MarkdownTextareaEdit {
  const { value, start, end } = normalizedSelection(selection);
  const selected = value.slice(start, end);
  const content = selected || placeholder;
  const replacement = `${prefix}${content}${suffix}`;

  return {
    value: `${value.slice(0, start)}${replacement}${value.slice(end)}`,
    selectionStart: start + prefix.length,
    selectionEnd: start + prefix.length + content.length,
  };
}

function insertLink(
  selection: MarkdownTextareaSelection
): MarkdownTextareaEdit {
  const { value, start, end } = normalizedSelection(selection);
  const selected = value.slice(start, end);
  const label = selected || "link text";
  const href = "https://";
  const replacement = `[${label}](${href})`;
  const selectionStart = selected ? start + label.length + 3 : start + 1;
  const selectionEnd = selected
    ? selectionStart + href.length
    : selectionStart + label.length;

  return {
    value: `${value.slice(0, start)}${replacement}${value.slice(end)}`,
    selectionStart,
    selectionEnd,
  };
}

function prefixSelectedLines(
  selection: MarkdownTextareaSelection,
  prefixForLine: (index: number) => string
): MarkdownTextareaEdit {
  const { value, start, end } = normalizedSelection(selection);
  const blockStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const nextNewline = value.indexOf("\n", end);
  const blockEnd = nextNewline === -1 ? value.length : nextNewline;
  const block = value.slice(blockStart, blockEnd);
  const lines = block.split("\n");
  const prefixes = lines.map((_line, index) => prefixForLine(index));
  const replacement = lines
    .map((line, index) => `${prefixes[index]}${line}`)
    .join("\n");

  if (start === end) {
    const currentLineIndex =
      value.slice(blockStart, start).split("\n").length - 1;
    const precedingPrefixLength = prefixes
      .slice(0, currentLineIndex + 1)
      .reduce((total, prefix) => total + prefix.length, 0);
    const nextCaret = start + precedingPrefixLength;
    return {
      value: `${value.slice(0, blockStart)}${replacement}${value.slice(blockEnd)}`,
      selectionStart: nextCaret,
      selectionEnd: nextCaret,
    };
  }

  return {
    value: `${value.slice(0, blockStart)}${replacement}${value.slice(blockEnd)}`,
    selectionStart: blockStart,
    selectionEnd: blockStart + replacement.length,
  };
}

/** Apply one Markdown-source formatting command without an editor runtime. */
export function formatMarkdownTextareaSelection(
  selection: MarkdownTextareaSelection,
  format: MarkdownTextareaFormat
): MarkdownTextareaEdit {
  switch (format) {
    case "heading":
      return prefixSelectedLines(selection, () => "## ");
    case "bold":
      return surroundSelection(selection, "**", "**", "bold text");
    case "italic":
      return surroundSelection(selection, "_", "_", "italic text");
    case "strikethrough":
      return surroundSelection(selection, "~~", "~~", "strikethrough");
    case "inlineCode": {
      const { value, start, end } = normalizedSelection(selection);
      const fence = value.slice(start, end).includes("`") ? "``" : "`";
      return surroundSelection(selection, fence, fence, "code");
    }
    case "link":
      return insertLink(selection);
    case "quote":
      return prefixSelectedLines(selection, () => "> ");
    case "bulletList":
      return prefixSelectedLines(selection, () => "- ");
    case "numberedList":
      return prefixSelectedLines(selection, (index) => `${index + 1}. `);
    case "taskList":
      return prefixSelectedLines(selection, () => "- [ ] ");
  }
}
