/**
 * React renderer for the app's Prism engine.
 *
 * `import { Prism } from "react-syntax-highlighter"` resolves through the
 * package barrel, which statically imports every refractor grammar (~280
 * modules) plus a bundled highlight.js build and the async-loader variants.
 * The `prism-light` entry is the same component over an empty `refractor`
 * singleton; the grammars it can render are exactly the ones registered in
 * `./prismGrammars`, which is also what the HTML-string path
 * (`./prismHtml`) uses — one engine, one grammar set.
 *
 * An unregistered language is not an error: react-syntax-highlighter checks
 * `listLanguages()` first and renders the code as plain text.
 */
import { createElement } from "react";
import type { ComponentType } from "react";
import type { SyntaxHighlighterProps } from "react-syntax-highlighter";
import SyntaxHighlighter from "react-syntax-highlighter/dist/esm/prism-light";

// Side effect: registers the grammar set on the shared refractor singleton.
import { resolvePrismLanguage } from "./prismGrammars";

// The dependency currently resolves its own React 18 types under pnpm while
// the app compiles against React 19. Its runtime component contract is still
// the public SyntaxHighlighterProps shape, so bridge only that type boundary.
const SyntaxHighlighterComponent =
  SyntaxHighlighter as unknown as ComponentType<SyntaxHighlighterProps>;

export {
  PRISM_LIGHT_LANGUAGES,
  isPrismLanguage,
  resolvePrismLanguage,
} from "./prismGrammars";

/**
 * Drop-in replacement for `Prism` from `react-syntax-highlighter`.
 *
 * Callers provide language names from editor state, Markdown fences, and tool
 * metadata. Normalize every React-rendered surface through the same canonical
 * registry as the HTML-string renderer so aliases cannot silently fall back to
 * plain text.
 */
export function PrismLight({ language, ...props }: SyntaxHighlighterProps) {
  return createElement(SyntaxHighlighterComponent, {
    ...props,
    language: resolvePrismLanguage(language) ?? "text",
  });
}
