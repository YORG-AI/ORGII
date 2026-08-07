/**
 * Renderer wrapper for `terminal-content` tabs (read-only terminal
 * output viewer opened from a pill double-click).
 *
 * Pipes `tab.data.content` through a read-only `CodeViewerContent` — a 1:1
 * mirror of `TabContentRenderer`'s `case "terminal-content"`. Self-contained:
 * it derives everything from `tab.data` and needs no host context (the viewer
 * takes `repoPath=""`).
 */
import React, { Suspense, memo } from "react";

import { Placeholder } from "@src/modules/shared/layouts/blocks";

import type { UnifiedTabContentProps } from "../types";

const CodeViewerContent = React.lazy(
  () =>
    import("@src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/CodeViewerContent")
);

const LazyFallback = () => (
  <Placeholder variant="loading" placement="detail-panel" fillParentHeight />
);

const TerminalContentTabRenderer: React.FC<UnifiedTabContentProps> = memo(
  ({ tab }) => {
    const terminalContent = String(tab.data.content || "");
    const terminalName =
      tab.data.terminalName || tab.title || "Terminal Output";

    return (
      <Suspense fallback={<LazyFallback />}>
        <CodeViewerContent
          selectedFile={String(terminalName)}
          fileContent={terminalContent}
          loading={false}
          error={null}
          repoPath=""
          readOnly={true}
        />
      </Suspense>
    );
  }
);

TerminalContentTabRenderer.displayName = "TerminalContentTabRenderer";

export default TerminalContentTabRenderer;
