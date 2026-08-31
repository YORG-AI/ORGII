// refractor@3 (the Prism core that react-syntax-highlighter's `prism-light`
// entry is built on) ships no declaration files. The app talks to it directly
// for HTML-string highlighting (`src/util/language/prismHtml.ts`) so that the
// chat/diff surfaces share one engine and one grammar set with the React
// `PrismLight` component instead of carrying a second highlighter.
declare module "refractor/core" {
  export interface RefractorTextNode {
    type: "text";
    value: string;
  }

  export interface RefractorElementNode {
    type: "element";
    tagName: string;
    properties: { className?: string[] } & Record<string, unknown>;
    children: RefractorNode[];
  }

  export type RefractorNode = RefractorTextNode | RefractorElementNode;

  export interface RefractorGrammar {
    (prism: unknown): void;
    displayName: string;
    aliases?: string[];
  }

  export interface Refractor {
    /** Register a grammar (and the aliases it declares). */
    register(grammar: RefractorGrammar): void;
    /** Add alias names for an already-registered language. */
    alias(name: string, alias: string | string[]): void;
    /** Tokenize `value` as `language` into a hast node list. Throws on unknown language. */
    highlight(value: string, language: string): RefractorNode[];
    /** Whether `language` (canonical name or alias) is registered. */
    registered(language: string): boolean;
    /** Registered language names, aliases included. */
    listLanguages(): string[];
  }

  const refractor: Refractor;
  export default refractor;
}

declare module "refractor/lang/*" {
  import type { RefractorGrammar } from "refractor/core";

  const grammar: RefractorGrammar;
  export default grammar;
}
