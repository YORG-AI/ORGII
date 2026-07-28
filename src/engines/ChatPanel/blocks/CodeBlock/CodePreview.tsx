/**
 * CodePreview — inline iframe sandbox for previewable code blocks.
 *
 * Triggered by the "Preview" button in ChatCodeBlock when the language is
 * html, svg, or css. Renders a sandboxed <iframe> directly beneath the code
 * fence with a slim toolbar (resize handle, open-in-browser, close).
 *
 * Security: sandbox="allow-scripts" only — no allow-same-origin, no
 * allow-forms, no allow-popups-to-escape-sandbox. No eval bridge is injected
 * into the document. External URLs are never loaded.
 */
import { ExternalLink, Maximize2, Minimize2, X } from "lucide-react";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { IFRAME_STYLE_NONCE, stampStyleNonces } from "@src/util/iframeCspNonce";

// ─── helpers ─────────────────────────────────────────────────────────────────

function buildHtmlDoc(code: string, language: string): string {
  if (language === "svg") {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style nonce="${IFRAME_STYLE_NONCE}">
      html,body{margin:0;display:flex;align-items:center;justify-content:center;
      min-height:100vh;background:#1a1a2e;overflow:auto;}
      svg{max-width:100%;height:auto;}
    </style></head><body>${code}</body></html>`;
  }
  if (language === "css") {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style nonce="${IFRAME_STYLE_NONCE}">
      *,*::before,*::after{box-sizing:border-box;}
      html,body{margin:0;padding:16px;background:#1a1a2e;color:#e0e0e0;
      font-family:system-ui,-apple-system,sans-serif;}
      ${code}
    </style></head><body>
      <p>CSS preview — add HTML elements to see styles applied.</p>
      <div class="preview-sample" style="margin-top:8px;padding:8px;
        border:1px solid rgba(255,255,255,.1);border-radius:4px">
        <h2>Sample heading</h2>
        <p>Sample paragraph with <a href="#">a link</a>.</p>
        <button>Button</button>
        <ul><li>List item 1</li><li>List item 2</li></ul>
      </div>
    </body></html>`;
  }
  // html (default) — user-authored body may contain its own <style> tags;
  // stamp nonces on the whole document so they survive WKWebView's CSP.
  return stampStyleNonces(`<!DOCTYPE html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      *,*::before,*::after{box-sizing:border-box;}
      html,body{margin:0;padding:16px;background:#1a1a2e;color:#e0e0e0;
      font-family:system-ui,-apple-system,sans-serif;min-height:100%;}
      a{color:#7c9ef7;}
      pre,code{font-family:ui-monospace,monospace;
        background:rgba(255,255,255,.05);padding:2px 4px;border-radius:4px;}
      pre{padding:12px;overflow-x:auto;}
    </style>
  </head><body>${code}</body></html>`);
}

// Height steps for the resize toggle (px)
const HEIGHT_STEPS = [200, 360, 520] as const;
type HeightStep = (typeof HEIGHT_STEPS)[number];

// ─── component ───────────────────────────────────────────────────────────────

export interface CodePreviewProps {
  code: string;
  language: string;
  onClose: () => void;
}

const CodePreview: React.FC<CodePreviewProps> = ({
  code,
  language,
  onClose,
}) => {
  const { t } = useTranslation("sessions");
  const [heightStep, setHeightStep] = useState<number>(0);

  const currentHeight: HeightStep =
    HEIGHT_STEPS[heightStep % HEIGHT_STEPS.length];
  const isMaxHeight = currentHeight === HEIGHT_STEPS[HEIGHT_STEPS.length - 1];

  const srcDoc = useMemo(
    () => buildHtmlDoc(code, language.toLowerCase()),
    [code, language]
  );

  const handleToggleSize = useCallback(() => {
    setHeightStep((prev) => (prev + 1) % HEIGHT_STEPS.length);
  }, []);

  const handleOpenExternal = useCallback(() => {
    const blob = new Blob([srcDoc], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank", "noopener,noreferrer");
    // Revoke after a short delay — the new tab will have loaded by then
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, [srcDoc]);

  return (
    <div className="animate-fade-in overflow-hidden rounded-b-md border border-t-0 border-border-1 bg-bg-2">
      {/* Toolbar */}
      <div className="flex items-center justify-between border-b border-border-1 bg-fill-2 px-3 py-1.5">
        <span className="text-xs font-medium text-text-3">
          {t("codePreview.label")}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleToggleSize}
            className="rounded p-1 text-text-4 transition-colors hover:bg-fill-3 hover:text-text-2"
            title={
              isMaxHeight ? t("codePreview.shrink") : t("codePreview.expand")
            }
          >
            {isMaxHeight ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </button>
          <button
            type="button"
            onClick={handleOpenExternal}
            className="rounded p-1 text-text-4 transition-colors hover:bg-fill-3 hover:text-text-2"
            title={t("codePreview.openExternal")}
          >
            <ExternalLink size={12} />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-text-4 transition-colors hover:bg-fill-3 hover:text-text-2"
            title={t("codePreview.close")}
          >
            <X size={12} />
          </button>
        </div>
      </div>

      {/* Sandboxed iframe */}
      <div
        className="relative w-full overflow-hidden transition-all duration-300"
        style={{ height: currentHeight }}
      >
        <iframe
          srcDoc={srcDoc}
          className="h-full w-full border-0"
          sandbox="allow-scripts"
          title={t("codePreview.iframeTitle")}
        />
      </div>
    </div>
  );
};

CodePreview.displayName = "CodePreview";

export default CodePreview;
