/**
 * Self-contained HTML document builder for agent-generated React artifacts.
 *
 * Ported from the public cloud viewer's `buildReactSandboxDocument`
 * (canvas-share `SharedReactCanvas.tsx`) so desktop and viewer keep identical
 * artifact semantics: normalize imports → sucrase transform → one HTML
 * document with the React 18 UMD runtimes inlined, an error overlay, and a
 * strict CSP `<meta>`.
 *
 * The packaged desktop webview ships `script-src 'self' 'wasm-unsafe-eval'`
 * (no eval, no inline scripts), and srcdoc iframes inherit that parent
 * policy, so this document cannot run in-page or via srcdoc. Instead it is
 * published to the Rust in-memory store (`canvas_artifact_publish`) and
 * served back on the dedicated `canvas-artifact` custom URI scheme
 * (`src-tauri/src/infrastructure/canvas_artifacts.rs`) — a real-`src` iframe
 * on its own origin whose response carries its own CSP, so the inline
 * runtime executes while staying fully sandboxed.
 */
// React 18 UMD runtimes inlined as text. The app itself runs React 19, which
// ships no UMD build; the cloud viewer pins 18 for exactly this reason, and
// reusing 18 keeps desktop/viewer artifact behavior identical. The aliases
// live in package.json (`react-artifact-runtime` → npm:react@18.3.1) so the
// app's own React 19 resolution is untouched. Imported through the repo-root
// `@/` alias as filesystem paths: react 18's package `exports` map has no
// `./umd/*` entry, so bare-specifier subpaths are rejected by webpack/vite.
import reactRuntime from "@/node_modules/react-artifact-runtime/umd/react.production.min.js?raw";
import reactDomRuntime from "@/node_modules/react-dom-artifact-runtime/umd/react-dom.production.min.js?raw";
import { transform } from "sucrase";

/**
 * CSP delivered both as the `<meta http-equiv>` inside the document and as
 * the `Content-Security-Policy` response header from the canvas-artifact
 * protocol handler (the effective policy is the intersection of the two —
 * keep them in sync with ARTIFACT_RESPONSE_CSP in canvas_artifacts.rs).
 * `connect-src 'none'` guarantees zero fetch/XHR/WebSocket egress from
 * artifact code, including to the Tauri IPC endpoints.
 */
export const REACT_ARTIFACT_FRAME_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; frame-src 'none'; base-uri 'none'";

const REACT_ARTIFACT_FRAME_CSP_META = `<meta http-equiv="Content-Security-Policy" content="${REACT_ARTIFACT_FRAME_CSP}">`;

/**
 * Artifacts may run scripts, but must never share an origin with the
 * canvas-artifact scheme (no allow-same-origin → opaque origin), open
 * popups, or navigate the app.
 */
export const REACT_ARTIFACT_FRAME_SANDBOX = "allow-scripts";

/**
 * Rewrites agent-emitted module syntax into the classic-runtime body the
 * artifact document executes: react imports are stripped (React/ReactDOM are
 * UMD globals) and the default export becomes a `render(<App />)` call.
 * Same lineage as the viewer's `normalizeReactSource` and the former
 * react-live normalization.
 */
export function normalizeReactArtifactSource(source: string): string {
  let code = source.replace(
    /^\s*import\s+React(?:\s*,\s*\{[^}]*\})?\s+from\s+["']react["'];?\s*$/gm,
    ""
  );
  code = code.replace(
    /^\s*import\s+\{[^}]*\}\s+from\s+["']react["'];?\s*$/gm,
    ""
  );

  if (/\bexport\s+default\s+function\s+App\s*\(/.test(code)) {
    code = code.replace(
      /\bexport\s+default\s+function\s+App\s*\(/,
      "function App("
    );
    return `${code}\nrender(<App />);`;
  }

  if (/\bexport\s+default\s+function\s*\(/.test(code)) {
    code = code.replace(/\bexport\s+default\s+function\s*\(/, "function App(");
    return `${code}\nrender(<App />);`;
  }

  const namedDefaultMatch = code.match(
    /\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/
  );
  if (namedDefaultMatch) {
    code = code.replace(namedDefaultMatch[0], "");
    return `${code}\nrender(<${namedDefaultMatch[1]} />);`;
  }

  if (/\bexport\s+default\s+/.test(code)) {
    code = code.replace(/\bexport\s+default\s+/, "const App = ");
    return `${code}\nrender(<App />);`;
  }

  if (/\bfunction\s+App\s*\(|\bconst\s+App\s*=|\blet\s+App\s*=/.test(code)) {
    return `${code}\nrender(<App />);`;
  }

  return code;
}

/**
 * A `</script` sequence inside inlined code would terminate the surrounding
 * script block early and let the artifact break out into document markup.
 * Escaping the closer keeps the payload inert inside the string.
 */
function escapeInlineScript(source: string): string {
  return source.replace(/<\/script/gi, "<\\/script");
}

/**
 * Compiles the artifact source and wraps it into the sandbox document.
 * Throws (sucrase SyntaxError) on uncompilable source — callers surface that
 * as a visible compile-error state. Runtime failures inside the artifact are
 * caught by the document's own error overlay (window `error` +
 * `unhandledrejection` listeners) and never reach the host page.
 */
export function buildReactArtifactDocument(source: string): string {
  const compiled = transform(normalizeReactArtifactSource(source), {
    transforms: ["typescript", "jsx"],
    production: true,
  }).code;
  return `<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${REACT_ARTIFACT_FRAME_CSP_META}
<style>*{box-sizing:border-box}html,body,#root{margin:0;min-height:100%;width:100%}body{background:#0b0d12;color:#f2f4f8;font-family:system-ui,-apple-system,sans-serif}#error{display:none;margin:16px;padding:12px;border:1px solid rgba(248,113,113,.35);border-radius:8px;background:rgba(127,29,29,.16);color:#fecaca;white-space:pre-wrap;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}</style>
</head><body><div id="root"></div><pre id="error"></pre>
<script>${escapeInlineScript(reactRuntime)}</script>
<script>${escapeInlineScript(reactDomRuntime)}</script>
<script>const errorElement=document.getElementById('error');function showError(error){errorElement.style.display='block';errorElement.textContent=error&&error.stack?error.stack:String(error)}window.addEventListener('error',event=>showError(event.error||event.message));window.addEventListener('unhandledrejection',event=>showError(event.reason));try{const root=ReactDOM.createRoot(document.getElementById('root'));const render=element=>root.render(element);${escapeInlineScript(compiled)}}catch(error){showError(error)}</script>
</body></html>`;
}
