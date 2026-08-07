/**
 * CSP nonce helpers for inline `<style>` tags inside sandboxed iframes.
 *
 * tauri.conf.json's `security.csp.style-src` is
 *   `'self' 'unsafe-inline' 'nonce-orgii-codemirror-style'`
 *
 * Per CSP3, once a `style-src` directive carries any nonce token, the
 * `'unsafe-inline'` keyword is invalidated. Every inline `<style>` we emit
 * into an iframe's srcdoc (which inherits the parent CSP under WKWebView,
 * regardless of sandbox flags) MUST stamp this nonce — otherwise WebKit
 * silently drops the stylesheet and the iframe renders unstyled in release
 * builds.
 *
 * The main-document path is already safe:
 *   • `public/index.html`'s `document.createElement` monkey-patch stamps
 *     the nonce onto every dynamically created `<style>` (catches
 *     style-loader and ad-hoc `createElement("style")` callers).
 *   • Build-time `<style>` blocks in `index.html` are hashed by Tauri's CSP
 *     processor at bundle time.
 *
 * Iframe srcdoc strings, however, are opaque to both: the `<style>` tags
 * inside them are parsed by the iframe's own HTML parser at runtime, not
 * via `document.createElement`. So every srcdoc producer must call
 * `stampStyleNonces` (or hard-code the nonce attribute) on the document
 * string before handing it to React.
 *
 * Dev builds use `style-loader` (inline `<style>` injected at runtime, all
 * of which go through `document.createElement` and get nonced) so missing
 * nonces are invisible there; release builds use `MiniCssExtractPlugin`
 * (external `<link>` files), at which point the missing-nonce mistake on
 * iframe srcdoc shows up as completely unstyled previews.
 */
import { CODEMIRROR_STYLE_NONCE } from "@src/features/CodeMirror/config/nonce";

/**
 * The single CSP nonce token shared by every srcdoc producer in the app.
 *
 * Re-exports `CODEMIRROR_STYLE_NONCE` so there is exactly one canonical
 * source of truth — the token name happens to be `orgii-codemirror-style`
 * for historical reasons (CodeMirror introduced it first), but it now
 * covers all inline-style use cases under Tauri's CSP.
 */
export const IFRAME_STYLE_NONCE = CODEMIRROR_STYLE_NONCE;

/**
 * Stamp `nonce="..."` onto every inline `<style>` tag in `html` that does
 * not already carry a `nonce` attribute. Idempotent — safe to call on
 * documents that already contain stamped tags.
 */
export function stampStyleNonces(html: string): string {
  return html.replace(
    /<style(\s[^>]*)?>/gi,
    (match, attrs: string | undefined) => {
      const attrString = attrs ?? "";
      if (/\snonce\s*=/i.test(attrString)) return match;
      return `<style${attrString} nonce="${IFRAME_STYLE_NONCE}">`;
    }
  );
}
