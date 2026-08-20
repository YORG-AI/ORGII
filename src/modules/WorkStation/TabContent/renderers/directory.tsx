/**
 * Renderer wrapper for `directory` tabs.
 *
 * Mirrors `TabContentRenderer`'s `case "directory"`: renders
 * `DirectoryExplorerContent`, pulling `repoPath` + `onFileSelect` from the
 * hoisted Code Editor host context (`useEditorHostContext`) and `directoryPath`
 * from `tab.data`.
 *
 * `directory` is editor-only — tabs are created only from
 * `CodeEditor/hooks/useCodeEditorEvents.ts` and recursively from
 * `DirectoryExplorerContent` itself — so coupling this renderer to the editor
 * host is safe: it throws if mounted outside an `EditorHostProvider`.
 */
import React, { Suspense, memo } from "react";

import { useEditorHostContext } from "@src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/context/editorHostContext";
import { Placeholder } from "@src/modules/shared/layouts/blocks";

import type { UnifiedTabContentProps } from "../types";

const DirectoryExplorerContent = React.lazy(
  () =>
    import("@src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/DirectoryExplorerContent")
);

const LazyFallback = () => (
  <Placeholder variant="loading" placement="detail-panel" fillParentHeight />
);

const DirectoryTabRenderer: React.FC<UnifiedTabContentProps> = memo(
  ({ tab }) => {
    const { repoPath, onFileSelect } = useEditorHostContext();
    const directoryPath = String(tab.data.directoryPath ?? "");

    return (
      <Suspense fallback={<LazyFallback />}>
        <DirectoryExplorerContent
          key={`${repoPath}:${directoryPath}`}
          directoryPath={directoryPath}
          repoPath={repoPath}
          onFileSelect={onFileSelect}
        />
      </Suspense>
    );
  }
);

DirectoryTabRenderer.displayName = "DirectoryTabRenderer";

export default DirectoryTabRenderer;
