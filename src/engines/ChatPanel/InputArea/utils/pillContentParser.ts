import type {
  ComposerPillAttrs,
  ComposerSnapshot,
} from "@src/components/ComposerInput/types";
import {
  PILL_REGEX,
  PILL_TYPE_LIST,
  type PillType,
} from "@src/config/pillTokens";

/**
 * Per-line variant of PILL_REGEX: the display-name capture group is restricted
 * to `[^\n[]` so it cannot swallow newlines. Used in `parsePillTextToSnapshot`
 * (which already splits by line) to keep the display name to the last
 * whitespace-delimited token before the bracket.
 */
const SINGLE_LINE_PILL_REGEX = new RegExp(
  `([^\\n[]+?)\\s*\\[(${PILL_TYPE_LIST.join("|")}):([^\\]]+)\\]`,
  "g"
);

/**
 * Separator injected by `pill_resolver.rs` when expanding pill references.
 * The backend appends this block to the user message before sending to the LLM,
 * so it gets stored in the DB as part of `display_text`. We must strip it when
 * loading into the edit editor so the user only sees their original message.
 */
const PILL_EXPANSION_SEPARATOR =
  "\n\n---\n**Referenced content (auto-expanded):**";

/**
 * Strips the auto-expanded pill content appended by the Rust `pill_resolver`.
 * Returns the original user message (everything before the separator).
 */
export function stripExpandedPillContent(text: string): string {
  const idx = text.indexOf(PILL_EXPANSION_SEPARATOR);
  return idx === -1 ? text : text.slice(0, idx);
}

export function hasPillSyntax(text: string): boolean {
  // Use PILL_REGEX (which can cross newlines) only for the fast-path check;
  // actual parsing uses SINGLE_LINE_PILL_REGEX per line.
  return PILL_REGEX.test(text);
}

/**
 * Parses pill-serialized text (e.g. `filename [file:path]`) into a
 * `ComposerSnapshot` understood by `ComposerInputRef.setContent`. Each
 * newline becomes a `newline` part so multi-line content round-trips correctly.
 */
export function parsePillTextToSnapshot(text: string): ComposerSnapshot {
  const parts: ComposerSnapshot["parts"] = [];
  const lines = text.split("\n");

  lines.forEach((line, lineIdx) => {
    if (lineIdx > 0) parts.push({ kind: "newline" });

    let lastIndex = 0;
    for (const match of line.matchAll(SINGLE_LINE_PILL_REGEX)) {
      const matchStart = match.index;
      if (matchStart === undefined) continue;

      // Split the raw capture into "preceding text on this line" + the actual
      // pill filename (last whitespace-delimited token before the bracket).
      //
      // When the user types in a language without inter-word spaces (CJK) and
      // the pill sits directly against the preceding text, there is no space
      // to anchor the split — treat all of `rawDisplayName` as preceding text
      // and fall back to the path's basename for the pill display name. The
      // alternative (treating the whole capture as the display name) would
      // swallow the user's prose into the pill (e.g. the entire Chinese
      // message would render as a single blue file pill).
      const rawDisplayName = match[1];
      const lastSpaceIdx = rawDisplayName.search(/\s[^\s]*$/);
      let precedingText: string;
      let fileName: string;
      const pillType = match[2] as PillType;
      if (lastSpaceIdx >= 0) {
        precedingText = rawDisplayName.slice(0, lastSpaceIdx + 1);
        fileName = rawDisplayName.slice(lastSpaceIdx + 1).trim();
      } else if (pillType === "session") {
        precedingText = "";
        fileName = rawDisplayName.trim();
      } else {
        precedingText = rawDisplayName;
        fileName = match[3].split("/").pop()?.split("::")[0] || match[3];
      }

      if (matchStart > lastIndex) {
        parts.push({ kind: "text", text: line.slice(lastIndex, matchStart) });
      }
      if (precedingText) {
        parts.push({ kind: "text", text: precedingText });
      }

      const filePath = match[3];

      const attrs: ComposerPillAttrs = {
        filePath,
        fileName,
        isFolder: pillType === "folder",
        iconType: pillType,
        lineStart: null,
        lineEnd: null,
      };
      parts.push({ kind: "pill", attrs });

      lastIndex = matchStart + match[0].length;
    }

    if (lastIndex < line.length) {
      parts.push({ kind: "text", text: line.slice(lastIndex) });
    }
  });

  return { parts };
}

/**
 * Calls `setContent` on a `ComposerInputRef`, parsing pill-serialized text
 * back into a `ComposerSnapshot` (with pill parts) when pill syntax is present.
 */
export function applyParsedContent(
  editor: { setContent: (content: string | ComposerSnapshot) => void },
  content: string
) {
  if (hasPillSyntax(content)) {
    editor.setContent(parsePillTextToSnapshot(content));
  } else {
    editor.setContent(content);
  }
}
