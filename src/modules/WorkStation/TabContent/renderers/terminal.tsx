/**
 * Renderer wrapper for the pinned `terminal` tab.
 *
 * Renders `TerminalMainContent` with the LIVE PTY runtime (`terminalState`)
 * from the hoisted Code Editor host context — a 1:1 mirror of
 * `TabContentRenderer`'s `case "terminal"`.
 *
 * IMPORTANT: `terminalState` MUST be the same instance the host holds; a fresh
 * runtime would detach from any running session. Note that in the live editor
 * host today the terminal is actually painted by a dedicated keep-alive overlay
 * in `EditorMainPane` (mounted while a terminal tab is active) — the switch's
 * `case "terminal"` is effectively unreachable there because `TabContentRenderer`
 * is not mounted while the terminal tab is active. This renderer preserves the
 * exact switch behaviour so the spec stays faithful for any host that routes the
 * `terminal` type through the dispatcher.
 */
import React, { Suspense, memo } from "react";

import { useEditorHostContext } from "@src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/context/editorHostContext";
import { Placeholder } from "@src/modules/shared/layouts/blocks";

import type { UnifiedTabContentProps } from "../types";

const TerminalMainContent = React.lazy(
  () =>
    import("@src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/TerminalMainContent")
);

const LazyFallback = () => (
  <Placeholder variant="loading" placement="detail-panel" fillParentHeight />
);

const TerminalTabRenderer: React.FC<UnifiedTabContentProps> = memo(() => {
  const { terminalState, repoPath } = useEditorHostContext();

  return (
    <Suspense fallback={<LazyFallback />}>
      <TerminalMainContent terminalState={terminalState} repoPath={repoPath} />
    </Suspense>
  );
});

TerminalTabRenderer.displayName = "TerminalTabRenderer";

export default TerminalTabRenderer;
