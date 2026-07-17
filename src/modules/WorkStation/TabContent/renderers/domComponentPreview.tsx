/**
 * Renderer wrapper for `dom-component-preview` tabs (paste-pill DOM JSON
 * with Raw / Preview toggle).
 *
 * `DomComponentPreviewContent` accepts only `fileName` + `jsonText`, both of
 * which live on `tab.data`. Fully self-contained — the previous placeholder's
 * "requires editor host context" note was stale (the component takes no host
 * props; the Code Editor mounts it the same way, straight from tab data).
 */
import React, { memo } from "react";

import DomComponentPreviewContent from "@src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/DomComponentPreviewContent";

import type { UnifiedTabContentProps } from "../types";

const DomComponentPreviewTabRenderer: React.FC<UnifiedTabContentProps> = memo(
  ({ tab }) => {
    const jsonText = String(tab.data.jsonText ?? "");
    const fileName = String(tab.data.fileName ?? tab.title ?? "Pasted JSON");
    return (
      <DomComponentPreviewContent fileName={fileName} jsonText={jsonText} />
    );
  }
);

DomComponentPreviewTabRenderer.displayName = "DomComponentPreviewTabRenderer";

export default DomComponentPreviewTabRenderer;
