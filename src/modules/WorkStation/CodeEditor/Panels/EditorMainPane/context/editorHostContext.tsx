/**
 * Code Editor host context — Phase 2.4 of the WorkStation unified-tab migration.
 *
 * Publishes the Code Editor host's live state + action surface ABOVE the tab
 * dispatcher so that `UnifiedTabContent` renderers for editor tab types
 * (`TabContent/renderers/{file,gitDiff,gitCommitDetail,…}.tsx`) can consume it
 * directly, instead of receiving it as a 14-field prop bag threaded through a
 * bespoke renderer. This is the "host context hoist" the editor tab renderers
 * depend on.
 *
 * The value is EXACTLY the fields the per-tab renderers consume (everything
 * except the per-tab `activeTab` — a renderer only handles its own tab, passed
 * via `UnifiedTabContentProps` — and the Source Control overlay / placeholder
 * props that stay owned by `EditorMainPane`). It is a standalone interface;
 * `editorHostValue` in `EditorMainPane` provides exactly these fields.
 *
 * CRITICAL — live-state instances:
 *   - `fileContentState` is the LIVE file-content manager (`useFileContentManager`
 *     in `EditorMainPane`); recreating it per-tab breaks editing/dirty-diff.
 *   - `terminalState` is the LIVE PTY runtime (`useTerminalState`, owned above
 *     `EditorMainPane`); recreating it per-tab breaks running terminals.
 * The provider MUST be mounted with the SAME instances the editor host already
 * holds — see `EditorMainPane/index.tsx`.
 *
 * See docs/workstation-unification/phase-2-host-hoist-plan.md (Phase 2.4).
 */
import type { UseTerminalStateReturn } from "@/src/engines/TerminalCore/exports";
import { type ReactNode, createContext, useContext } from "react";

import type { CursorPosition } from "@src/modules/WorkStation/shared/StatusBar/EditorStatusBar";
import type { GitFile } from "@src/types/git/types";

import type { Diagnostic } from "../../EditorBottomPanel/content/ProblemsContent/types";
import type { UseFileContentManagerReturn } from "../hooks/useFileContentManager";

/**
 * The live host state + callbacks published to editor tab renderers. Exactly
 * the 14 fields the editor host threads from `EditorMainPane` (minus the
 * per-tab `activeTab` and the Source Control overlay / placeholder props).
 */
export interface EditorHostContextValue {
  /** File content manager state */
  fileContentState: UseFileContentManagerReturn;
  /** Git files by path for diff viewing */
  gitFilesByPath: Map<string, GitFile>;
  /** Whether git diff is loading */
  gitDiffLoading: boolean;
  /** Force refresh git status */
  forceRefresh: () => void;
  /** File select callback */
  onFileSelect: (path: string) => void;
  /** File select with line number callback (for navigating to a specific line) */
  onFileSelectWithLine?: (path: string, line: number) => void;
  /** Diagnostics change callback */
  onDiagnosticsChange?: (diagnostics: Diagnostic[]) => void;
  /** Cursor position change callback */
  onCursorPositionChange?: (position: CursorPosition | null) => void;
  /** Update an active search tab title from its query */
  onSearchTabTitleChange?: (tabId: string, query: string) => void;
  /** Sync git-diff local edits to tab bar unsaved indicator */
  onGitDiffUnsavedChange?: (hasUnsaved: boolean) => void;
  /** Sync binary preview edits to tab bar unsaved indicator */
  onBinaryUnsavedChange?: (hasUnsaved: boolean) => void;
  /** Shared terminal runtime state for the pinned Terminal tab */
  terminalState: UseTerminalStateReturn;
  /** Repository path */
  repoPath: string;
  /** Repository id from selection state */
  repoId: string | null;
}

const EditorHostContext = createContext<EditorHostContextValue | null>(null);

export function EditorHostProvider({
  value,
  children,
}: {
  value: EditorHostContextValue;
  children: ReactNode;
}) {
  return (
    <EditorHostContext.Provider value={value}>
      {children}
    </EditorHostContext.Provider>
  );
}

/**
 * Read the Code Editor host context. Throws if used outside an
 * `EditorHostProvider` — this guards against mounting an editor renderer
 * through the unified dispatcher before the host context has been hoisted above
 * it (which would otherwise silently render a degraded surface without the live
 * file-content manager / PTY runtime).
 */
export function useEditorHostContext(): EditorHostContextValue {
  const ctx = useContext(EditorHostContext);
  if (ctx === null) {
    throw new Error(
      "useEditorHostContext must be used within an EditorHostProvider"
    );
  }
  return ctx;
}
