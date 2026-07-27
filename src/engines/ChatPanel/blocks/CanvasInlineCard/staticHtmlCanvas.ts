import { IFRAME_STYLE_NONCE } from "@src/util/iframeCspNonce";

export const STATIC_HTML_STYLES = `
  :host{display:block;height:100%;min-width:0;overflow:hidden;background:var(--color-bg-1);color:var(--color-text-1);font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;line-height:1.6;}
  *,*::before,*::after{box-sizing:border-box;}
  a{color:var(--color-primary-6);text-decoration:none;}
  a:hover{text-decoration:underline;}
  pre,code{font-family:monospace;background:var(--color-fill-2);padding:2px 5px;border-radius:4px;font-size:.875em;}
  pre{padding:12px 16px;overflow-x:auto;border-radius:6px;border:1px solid var(--color-border-1);}
  pre code{background:none;padding:0;}
  img{max-width:100%;height:auto;border-radius:4px;}
  ::-webkit-scrollbar{width:6px;height:6px;}
  ::-webkit-scrollbar-track{background:transparent;}
  ::-webkit-scrollbar-thumb{background:var(--color-fill-4);border-radius:3px;}
`;

export const STATIC_HTML_CONTAINMENT_STYLES = `
  :host{contain:layout paint style;isolation:isolate;}
  .canvas-static-html{position:relative;height:100%;min-width:0;max-width:100%;overflow:auto;contain:layout paint style;isolation:isolate;}
  .canvas-static-html *{max-width:100%;}
`;

export function extractStaticHtmlBody(content: string): string {
  const bodyMatch = content.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return bodyMatch?.[1] ?? content;
}

export function extractStaticHtmlStyles(content: string): string {
  const styles = Array.from(
    content.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)
  )
    .map((match) => match[1].replace(/<\/style/gi, ""))
    .join("\n");
  return sanitizeStaticHtmlStyles(styles);
}

/**
 * Shadow DOM scopes selectors but is not a security boundary. Keep authored
 * presentation CSS only when it cannot address the host, escape through fixed
 * positioning, or trigger network loads. A rejected stylesheet degrades to the
 * built-in canvas theme instead of weakening containment.
 */
export function sanitizeStaticHtmlStyles(styles: string): string {
  const normalizedStyles = styles.replace(/\/\*[\s\S]*?\*\//g, "");
  const crossesBoundary =
    /\\|@(?:import|namespace)\b|url\s*\(|:host(?:-context)?\b|(?:^|[;{])\s*position\s*:\s*(?:fixed|sticky)\b|expression\s*\(|behavior\s*:/i;
  return crossesBoundary.test(normalizedStyles) ? "" : styles;
}

/**
 * Build the Shadow DOM tree used by static HTML canvases.
 *
 * WKWebView applies the parent Tauri CSP to styles created through
 * `shadowRoot.innerHTML`. Because the policy contains a nonce source, every
 * style block must carry the canonical nonce or WebKit silently discards it.
 */
export function buildStaticHtmlShadowMarkup(
  safeContent: string,
  styles: string
): string {
  const styleTag = (css: string) =>
    `<style nonce="${IFRAME_STYLE_NONCE}">${css}</style>`;

  return `${styleTag(STATIC_HTML_STYLES)}${styleTag(styles)}${styleTag(STATIC_HTML_CONTAINMENT_STYLES)}<div class="canvas-static-html" style="position:relative!important;height:100%!important;min-width:0!important;max-width:100%!important;overflow:auto!important;contain:layout paint style!important;isolation:isolate!important">${safeContent}</div>`;
}
