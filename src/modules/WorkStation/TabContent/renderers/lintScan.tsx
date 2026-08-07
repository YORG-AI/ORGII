/**
 * Renderer wrapper for `lint-scan` tabs.
 *
 * `LintScanContent` needs a `repoPath` prop. We pull it from the hoisted Code
 * Editor host context (`useEditorHostContext`) for strict parity with
 * `TabContentRenderer`'s `case "lint-scan"`, which passed the host's selected
 * `repoPath` (not the active workspace root). `lint-scan` is editor-only, so
 * coupling this renderer to the editor host is safe — it throws if mounted
 * outside an `EditorHostProvider`.
 */
import React, { memo } from "react";

import LintScanContent from "@src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/LintScanContent";
import { useEditorHostContext } from "@src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/context/editorHostContext";

import type { UnifiedTabContentProps } from "../types";

const LintScanTabRenderer: React.FC<UnifiedTabContentProps> = memo(() => {
  const { repoPath } = useEditorHostContext();
  return <LintScanContent repoPath={repoPath} />;
});

LintScanTabRenderer.displayName = "LintScanTabRenderer";

export default LintScanTabRenderer;
