/**
 * HTML document builders for CanvasInlineCard iframe content.
 *
 * All documents are injected via `srcDoc` into sandboxed iframes
 * (sandbox="allow-scripts") — no allow-same-origin. React mode is fully inline
 * and does not import external runtime scripts.
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

function escapeScriptContent(value: string): string {
  return value.replace(/<\/script/gi, "<\\/script");
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

export function buildReactDocument(source: string): string {
  const escapedSource = escapeScriptContent(source);
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style nonce="${IFRAME_STYLE_NONCE}">${BASE_STYLES}
body{padding:16px;background:#0f1018;color:#f3f4f8;}
#root{min-height:100vh;}
#error{display:none;margin:12px 0;padding:12px;border:1px solid #ef4444;border-radius:8px;background:rgba(239,68,68,.1);color:#fecaca;white-space:pre-wrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;}
</style>
</head><body><div id="root"></div><pre id="error"></pre>
<script nonce="${IFRAME_STYLE_NONCE}">
const source = ${JSON.stringify(escapedSource)};
const errorEl = document.getElementById('error');
function showError(error){
  errorEl.style.display='block';
  errorEl.textContent = error && error.stack ? error.stack : String(error);
}
function createElement(type, props, ...children){
  return { type, props: props || {}, children: children.flat() };
}
function appendValue(parent, value){
  if (value === null || value === undefined || value === false || value === true) return;
  if (Array.isArray(value)) {
    value.forEach((child)=>appendValue(parent, child));
    return;
  }
  if (typeof value === 'string' || typeof value === 'number') {
    parent.appendChild(document.createTextNode(String(value)));
    return;
  }
  if (typeof value.type === 'function') {
    appendValue(parent, value.type({ ...value.props, children: value.children }));
    return;
  }
  if (typeof value.type !== 'string') throw new Error('React canvas can only render DOM elements and function components.');
  const node = document.createElement(value.type);
  Object.entries(value.props || {}).forEach(([key, propValue])=>{
    if (key === 'children' || propValue === null || propValue === undefined || propValue === false) return;
    if (key === 'className') node.setAttribute('class', String(propValue));
    else if (key === 'style' && typeof propValue === 'object') Object.assign(node.style, propValue);
    else if (key.startsWith('on') && typeof propValue === 'function') node.addEventListener(key.slice(2).toLowerCase(), propValue);
    else node.setAttribute(key, String(propValue));
  });
  value.children.forEach((child)=>appendValue(node, child));
  parent.appendChild(node);
}
window.addEventListener('error',event=>showError(event.error||event.message));
window.addEventListener('unhandledrejection',event=>showError(event.reason));
try {
  const normalized = source
    .replace(/export\\s+default\\s+function\\s+App\\s*\\(/, 'function App(')
    .replace(/export\\s+default\\s+App\\s*;?/, '')
    .replace(/export\\s+default\\s+/, 'const App = ');
  const React = { createElement };
  const module = { exports: {} };
  const exports = module.exports;
  const factory = new Function('React','module','exports', normalized + '\\n;return module.exports.default || module.exports.App || exports.default || exports.App || (typeof App !== "undefined" ? App : undefined);');
  const App = factory(React, module, exports);
  if (typeof App !== 'function') throw new Error('React canvas expected content to define or export an App component. JSX is not transformed in this MVP; use React.createElement or precompiled JavaScript. Hooks and ReactDOM APIs are not available in the sandbox.');
  appendValue(document.getElementById('root'), React.createElement(App));
} catch (error) {
  showError(error);
}
</script></body></html>`;
}
