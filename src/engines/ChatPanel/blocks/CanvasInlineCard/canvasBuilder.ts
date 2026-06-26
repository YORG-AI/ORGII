/**
 * HTML document builders for CanvasInlineCard iframe content.
 *
 * All documents are injected via `srcDoc` into sandboxed iframes
 * (sandbox="allow-scripts") — no allow-same-origin, no network access.
 *
 * CSP note: tauri.conf.json's `style-src` carries a nonce token, which per
 * CSP3 invalidates the `'unsafe-inline'` keyword sitting next to it. Every
 * inline `<style>` we emit MUST stamp the canonical iframe nonce
 * (see `src/util/iframeCspNonce.ts`) or WKWebView silently drops it.
 */
import { IFRAME_STYLE_NONCE, stampStyleNonces } from "@src/util/iframeCspNonce";

const BASE_STYLES = `
  *,*::before,*::after{box-sizing:border-box;}
  html,body{margin:0;padding:0;background:#141420;color:#e2e2e8;
    font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    font-size:14px;line-height:1.6;min-height:100%;overflow-x:auto;}
  a{color:#7c9ef7;text-decoration:none;}
  a:hover{text-decoration:underline;}
  pre,code{font-family:monospace;
    background:rgba(255,255,255,.06);padding:2px 5px;border-radius:4px;font-size:0.875em;}
  pre{padding:12px 16px;overflow-x:auto;border-radius:6px;
    border:1px solid rgba(255,255,255,.08);}
  pre code{background:none;padding:0;}
  img{max-width:100%;height:auto;border-radius:4px;}
  button{cursor:pointer;}
  ::-webkit-scrollbar{width:6px;height:6px;}
  ::-webkit-scrollbar-track{background:transparent;}
  ::-webkit-scrollbar-thumb{background:rgba(255,255,255,.15);border-radius:3px;}
`;

const EVAL_BRIDGE_SCRIPT = `
window.addEventListener('message',(e)=>{
  if(e.data&&e.data.type==='canvas_eval'&&e.data.javascript){
    try{eval(e.data.javascript);}catch(err){console.error('[canvas]',err);}
  }
});
`;

/**
 * Detect a payload that is already a full HTML document. Nesting another
 * `<html>` / `<head>` inside our wrapper `<body>` produces malformed markup
 * that WebKit recovers from by dropping the nested `<head>` (and its
 * `<style>`) — every custom class then renders unstyled. When the agent
 * ships a complete document, we stamp nonces onto its inline styles and
 * return it as-is rather than re-wrapping.
 */
function isFullHtmlDocument(html: string): boolean {
  const head = html.trimStart().slice(0, 200).toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

/** Wrap arbitrary HTML in the sandbox template. */
export function buildHtmlDocument(html: string): string {
  if (isFullHtmlDocument(html)) {
    // Agent supplied a full document. Stamp nonces onto its inline <style>
    // blocks and ship it directly — wrapping it in another <html>/<body>
    // would invalidate the markup and strip the agent's styles.
    return stampStyleNonces(html);
  }
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style nonce="${IFRAME_STYLE_NONCE}">${BASE_STYLES}</style>
<script nonce="${IFRAME_STYLE_NONCE}">${EVAL_BRIDGE_SCRIPT}</script>
</head><body style="padding:16px">${html}</body></html>`;
}
