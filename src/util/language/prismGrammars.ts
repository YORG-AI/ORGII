/**
 * The app's single syntax-highlighting engine: Prism, via `refractor`, with an
 * explicit grammar set.
 *
 * Every highlighted surface — Markdown code fences, the code/diff viewers,
 * terminal command lines, and tool output — tokenizes through the one
 * `refractor` singleton registered here. The React component
 * path (`./prismLight`) and the HTML-string path (`./prismHtml`) are two
 * renderers over the same tokens, so a grammar added below lights up
 * everywhere at once and the bundle carries one highlighter.
 *
 * `refractor/core` starts empty. The set below covers everything the app's
 * language registry can produce that Prism knows
 * (`src/config/languageRegistry.ts`,
 * `src/util/editor/extension.tsx`, markdown fence info strings, the terminal
 * / tool-output surfaces). An unregistered language is not an error: callers
 * check `isPrismLanguage()` (or let `PrismLight` fall back) and render plain
 * text, which is also what the full Prism build did for unknown names.
 *
 * Prism's built-in aliases are declared by the grammars themselves. App,
 * editor, and legacy-highlighter aliases are resolved by the canonical
 * config-level language registry before the registered-grammar check.
 *
 * This module is reached only through dynamic `import()` (see `prismHtml`
 * / `useSyntaxHighlight`) or from chunks that are themselves lazy (the
 * Markdown renderer, the code viewer), so the grammar set never lands in the
 * startup graph — `src/app/root/__tests__/startupGraph.test.ts` enforces it.
 */
import refractor from "refractor/core";
import bash from "refractor/lang/bash";
import c from "refractor/lang/c";
import clojure from "refractor/lang/clojure";
import cmake from "refractor/lang/cmake";
import cpp from "refractor/lang/cpp";
import csharp from "refractor/lang/csharp";
import css from "refractor/lang/css";
import dart from "refractor/lang/dart";
import diff from "refractor/lang/diff";
import docker from "refractor/lang/docker";
import elixir from "refractor/lang/elixir";
import elm from "refractor/lang/elm";
import erlang from "refractor/lang/erlang";
import git from "refractor/lang/git";
import go from "refractor/lang/go";
import graphql from "refractor/lang/graphql";
import haskell from "refractor/lang/haskell";
import hcl from "refractor/lang/hcl";
import ini from "refractor/lang/ini";
import java from "refractor/lang/java";
import javascript from "refractor/lang/javascript";
import json from "refractor/lang/json";
import json5 from "refractor/lang/json5";
import jsx from "refractor/lang/jsx";
import kotlin from "refractor/lang/kotlin";
import less from "refractor/lang/less";
import log from "refractor/lang/log";
import lua from "refractor/lang/lua";
import makefile from "refractor/lang/makefile";
import markdown from "refractor/lang/markdown";
import markup from "refractor/lang/markup";
import nginx from "refractor/lang/nginx";
import objectivec from "refractor/lang/objectivec";
import ocaml from "refractor/lang/ocaml";
import perl from "refractor/lang/perl";
import php from "refractor/lang/php";
import powershell from "refractor/lang/powershell";
import protobuf from "refractor/lang/protobuf";
import python from "refractor/lang/python";
import r from "refractor/lang/r";
import ruby from "refractor/lang/ruby";
import rust from "refractor/lang/rust";
import sass from "refractor/lang/sass";
import scala from "refractor/lang/scala";
import shellSession from "refractor/lang/shell-session";
import sql from "refractor/lang/sql";
import swift from "refractor/lang/swift";
import toml from "refractor/lang/toml";
import tsx from "refractor/lang/tsx";
import typescript from "refractor/lang/typescript";
import vim from "refractor/lang/vim";
import yaml from "refractor/lang/yaml";
import zig from "refractor/lang/zig";

import { getSyntaxHighlighterLanguage } from "@src/config/languageRegistry";

import scss from "refractor/lang/scss";

/** Grammar name → refractor grammar. Keys are Prism's canonical names. */
const PRISM_GRAMMARS = {
  bash,
  c,
  clojure,
  cmake,
  cpp,
  csharp,
  css,
  dart,
  diff,
  docker,
  elixir,
  elm,
  erlang,
  git,
  go,
  graphql,
  haskell,
  hcl,
  ini,
  java,
  javascript,
  json,
  json5,
  jsx,
  kotlin,
  less,
  log,
  lua,
  makefile,
  markdown,
  markup,
  nginx,
  objectivec,
  ocaml,
  perl,
  php,
  powershell,
  protobuf,
  python,
  r,
  ruby,
  rust,
  sass,
  scala,
  scss,
  "shell-session": shellSession,
  sql,
  swift,
  toml,
  tsx,
  typescript,
  vim,
  yaml,
  zig,
} as const;

for (const grammar of Object.values(PRISM_GRAMMARS)) {
  refractor.register(grammar);
}

/** Registered Prism grammar names (canonical names only, aliases excluded). */
export const PRISM_LIGHT_LANGUAGES: readonly string[] =
  Object.keys(PRISM_GRAMMARS);

/**
 * Map a language name from any of the app's sources (file extension
 * mapper, fence info string, tool metadata) to a registered Prism language,
 * or `null` when Prism has no grammar for it.
 */
export function resolvePrismLanguage(lang: string | undefined): string | null {
  const candidate = getSyntaxHighlighterLanguage(lang);
  if (!candidate) return null;
  return refractor.registered(candidate) ? candidate : null;
}

/** Whether `lang` (after alias resolution) has a registered Prism grammar. */
export function isPrismLanguage(lang: string | undefined): boolean {
  return resolvePrismLanguage(lang) !== null;
}

export { refractor };
