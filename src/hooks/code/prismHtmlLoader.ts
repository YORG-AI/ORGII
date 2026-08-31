/**
 * Single lazy loader for the app's Prism HTML engine.
 *
 * `src/util/language/prismHtml` carries the full grammar set, so it is only
 * ever reached through this dynamic `import()`; the static-import boundary
 * tests (`src/app/root/__tests__`) rely on that. Every
 * `useSyntaxHighlight` caller shares the same module promise.
 */
type PrismHtmlModule = typeof import("@src/util/language/prismHtml");

let modulePromise: Promise<PrismHtmlModule> | null = null;

/** Start loading (idempotent) and resolve with the engine module. */
export function loadPrismHtml(): Promise<PrismHtmlModule> {
  if (!modulePromise) {
    modulePromise = import(
      /* webpackChunkName: "prism-html" */ "@src/util/language/prismHtml"
    ).catch((error: unknown) => {
      // Let a transient chunk-load failure retry on the next call.
      modulePromise = null;
      throw error;
    });
  }
  return modulePromise;
}
