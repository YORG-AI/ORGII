import React, { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { IFRAME_STYLE_NONCE } from "@src/util/iframeCspNonce";

import { parseCanvasDomComponent } from "./domComponentPayload";
import { sanitizeDomPreviewHtml } from "./domPreviewHtml";

interface CanvasDomComponentPreviewProps {
  jsonText: string;
}

function buildPreviewDocument(previewHtml: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style nonce="${IFRAME_STYLE_NONCE}">
  html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;color:inherit;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;}
  body{display:flex;align-items:center;justify-content:center;padding:10px;box-sizing:border-box;}
  .canvas-selection-preview{display:flex;max-width:100%;max-height:100%;align-items:center;justify-content:center;transform:scale(.8);transform-origin:center;}
  .canvas-selection-preview>*{max-width:100%;max-height:100%;}
</style>
</head>
<body><div class="canvas-selection-preview">${previewHtml}</div></body>
</html>`;
}

const CanvasDomComponentPreview: React.FC<CanvasDomComponentPreviewProps> =
  memo(({ jsonText }) => {
    const { t } = useTranslation("sessions");
    const srcDoc = useMemo(() => {
      const parsed = parseCanvasDomComponent(jsonText);
      if (!parsed?.previewHtml) return null;
      return buildPreviewDocument(
        sanitizeDomPreviewHtml(parsed.previewHtml, 32_000)
      );
    }, [jsonText]);

    if (!srcDoc) return null;

    // Contained card frame: theme background + border tokens and clipped
    // overflow keep the captured fragment from floating unframed in chat.
    return (
      <div className="max-h-28 w-full overflow-hidden rounded-lg border border-border-2 bg-bg-1">
        <iframe
          title={t("domSelection.previewTitle", "Canvas selection preview")}
          sandbox=""
          srcDoc={srcDoc}
          tabIndex={-1}
          className="pointer-events-none h-28 w-full border-0"
        />
      </div>
    );
  });

CanvasDomComponentPreview.displayName = "CanvasDomComponentPreview";

export default CanvasDomComponentPreview;
