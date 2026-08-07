declare module "shiki/core" {
  export { createBundledHighlighter, makeSingletonHighlighter } from "shiki";
}

declare module "shiki/engine/javascript" {
  export { createJavaScriptRegexEngine } from "shiki";
}

declare module "shiki/langs/*.mjs" {
  import type { LanguageRegistration } from "shiki";

  const language: LanguageRegistration;
  export default language;
}

declare module "shiki/themes/*.mjs" {
  import type { ThemeRegistration } from "shiki";

  const theme: ThemeRegistration;
  export default theme;
}
