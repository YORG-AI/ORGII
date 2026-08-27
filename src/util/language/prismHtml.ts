/**
 * HTML-string renderer for the app's Prism engine.
 *
 * For surfaces that paint highlighted code with `dangerouslySetInnerHTML`
 * (terminal command lines and tool output) this turns Prism's
 * token tree into `<span class="token …">` markup. Colors are not inlined:
 * the spans are themed by the `.prism-html .token.*` rules in
 * `src/styles/prism-tokens.scss`, which read the same `--cm-syntax-*`
 * tokens as the CodeMirror editor and the `PrismLight` inline theme, so
 * every code surface follows the active light / dark / high-contrast theme.
 *
 * Load this module with a dynamic `import()` — it pulls the full grammar
 * set. `useSyntaxHighlight` does that and caches results per code string.
 */
import type { RefractorNode } from "refractor/core";

import { refractor, resolvePrismLanguage } from "./prismGrammars";

export { isPrismLanguage, resolvePrismLanguage } from "./prismGrammars";

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape text for insertion into HTML element content or attribute values. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

function serializeNodes(nodes: RefractorNode[], out: string[]): void {
  for (const node of nodes) {
    if (node.type === "text") {
      out.push(escapeHtml(node.value));
      continue;
    }
    const className = node.properties.className;
    const classAttr =
      className && className.length > 0
        ? ` class="${escapeHtml(className.join(" "))}"`
        : "";
    out.push(`<${node.tagName}${classAttr}>`);
    serializeNodes(node.children, out);
    out.push(`</${node.tagName}>`);
  }
}

/**
 * Highlight `code` as `lang` and return the inner HTML (token spans and
 * escaped text, no wrapping `<pre>`/`<code>`), or `null` when Prism has no
 * grammar for the language — callers then render the plain text themselves.
 *
 * Never throws: a tokenizer failure also yields `null`.
 */
export function highlightToHtml(
  code: string,
  lang: string | undefined
): string | null {
  const language = resolvePrismLanguage(lang);
  if (!language) return null;
  try {
    const out: string[] = [];
    serializeNodes(refractor.highlight(code, language), out);
    return out.join("");
  } catch {
    return null;
  }
}
