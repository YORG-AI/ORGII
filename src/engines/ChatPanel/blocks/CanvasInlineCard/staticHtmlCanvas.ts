import DOMPurify from "dompurify";

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
  ::-webkit-scrollbar-thumb{background:var(--scrollbar-thumb-color);border-radius:3px;}
  ::-webkit-scrollbar-thumb:hover{background:var(--scrollbar-thumb-hover-color);}
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

export function sanitizeStaticHtmlBody(content: string): string {
  const sanitized = DOMPurify.sanitize(extractStaticHtmlBody(content), {
    FORBID_TAGS: [
      "script",
      "iframe",
      "object",
      "embed",
      "link",
      "meta",
      "base",
      "style",
    ],
    // HTML mode is intentionally static. Keep presentational inline styles,
    // while DOMPurify removes script tags and event-handler attributes.
    // Interactive sketches belong in React mode.
    FORBID_ATTR: ["srcdoc"],
  });

  if (typeof DOMParser === "undefined") {
    return DOMPurify.sanitize(sanitized, {
      FORBID_ATTR: [
        "action",
        "background",
        "cite",
        "formaction",
        "href",
        "poster",
        "src",
        "srcset",
        "style",
        "xlink:href",
      ],
    });
  }

  const document = new DOMParser().parseFromString(
    `<body>${sanitized}</body>`,
    "text/html"
  );
  for (const element of document.body.querySelectorAll("*")) {
    const inlineStyle = element.getAttribute("style");
    if (inlineStyle && containsBoundaryCrossingCss(inlineStyle)) {
      element.removeAttribute("style");
    }

    for (const attribute of NETWORK_CAPABLE_ATTRIBUTES) {
      const value = element.getAttribute(attribute);
      if (value !== null && !isSafeEmbeddedResource(attribute, value)) {
        element.removeAttribute(attribute);
      }
    }
  }

  return document.body.innerHTML;
}

const NETWORK_CAPABLE_ATTRIBUTES = [
  "action",
  "background",
  "cite",
  "formaction",
  "href",
  "poster",
  "src",
  "srcset",
  "xlink:href",
] as const;

function isSafeEmbeddedResource(attribute: string, value: string): boolean {
  const normalized = value.trim();
  if (
    (attribute === "href" || attribute === "xlink:href") &&
    normalized.startsWith("#")
  ) {
    return true;
  }
  return (
    attribute === "src" &&
    /^data:image\/(?:png|gif|jpe?g|webp);base64,/i.test(normalized)
  );
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
  return containsBoundaryCrossingCss(styles) ? "" : styles;
}

function containsBoundaryCrossingCss(styles: string): boolean {
  const normalizedStyles = styles.replace(/\/\*[\s\S]*?\*\//g, "");
  return /\\|@(?:import|namespace)\b|url\s*\(|:host(?:-context)?\b|(?:^|[;{])\s*position\s*:\s*(?:fixed|sticky)\b|expression\s*\(|behavior\s*:/i.test(
    normalizedStyles
  );
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
