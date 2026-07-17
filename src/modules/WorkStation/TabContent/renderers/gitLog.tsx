/**
 * Renderer wrapper for `git-log` tabs (git error-log viewer).
 *
 * Synthesises the multi-line error banner from
 * `tab.data.operation/errorMessage/commandOutput` and pipes it into a read-only
 * `CodeViewerContent` — a 1:1 mirror of `TabContentRenderer`'s `case "git-log"`.
 * Self-contained: it derives everything from `tab.data` and needs no host
 * context (the read-only viewer takes `repoPath=""`).
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

const GitLogTabRenderer: React.FC<UnifiedTabContentProps> = memo(({ tab }) => {
  const operation = String(tab.data.operation || "unknown");
  const errorMessage = String(tab.data.errorMessage || "");
  const commandOutput = tab.data.commandOutput
    ? String(tab.data.commandOutput)
    : undefined;
  const timestamp = tab.data.timestamp ? String(tab.data.timestamp) : undefined;
  const virtualFileName = tab.data.virtualFileName || tab.title || "git-error";

  const errorTime = timestamp ? new Date(timestamp) : new Date();
  const lines: string[] = [
    `═══════════════════════════════════════════════════════════════`,
    `  Git ${operation.charAt(0).toUpperCase() + operation.slice(1)} Failed`,
    `  ${errorTime.toLocaleString()}`,
    `═══════════════════════════════════════════════════════════════`,
    ``,
    `Message:`,
    `─────────────────────────────────────────────────────────────────`,
    errorMessage,
    `─────────────────────────────────────────────────────────────────`,
    ``,
  ];
  if (commandOutput && commandOutput !== errorMessage) {
    lines.push(
      `Command Output:`,
      `─────────────────────────────────────────────────────────────────`,
      commandOutput,
      `─────────────────────────────────────────────────────────────────`
    );
  }
  const gitLogContent = lines.join("\n");

  return (
    <Suspense fallback={<LazyFallback />}>
      <CodeViewerContent
        selectedFile={String(virtualFileName)}
        fileContent={gitLogContent}
        loading={false}
        error={null}
        repoPath=""
        readOnly={true}
      />
    </Suspense>
  );
});

GitLogTabRenderer.displayName = "GitLogTabRenderer";

export default GitLogTabRenderer;
