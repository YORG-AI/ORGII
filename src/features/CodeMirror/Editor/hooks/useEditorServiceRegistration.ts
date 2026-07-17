/**
 * useEditorServiceRegistration Hook
 *
 * Manages registration of the EditorView with EditorService for AI/service access.
 * Also provides the scroll element for custom scrollbar integration.
 */
import { EditorView } from "@codemirror/view";
import { useCallback, useEffect, useState } from "react";

import { EditorService } from "@src/services/workStation/EditorService";

export interface UseEditorServiceRegistrationOptions {
  /** Register with EditorService (default: true) */
  registerWithService?: boolean;
}

export interface EditorServiceRegistrationResult {
  /** Callback to pass to CodeMirror's onCreateEditor */
  handleCreateEditor: (view: EditorView) => void;
  /** The scroll element from EditorView (for custom scrollbar) */
  scrollElement: HTMLElement | null;
  /** Total line count in the document */
  totalLines: number;
}

/**
 * Hook to manage EditorService registration and scroll element tracking
 */
export function useEditorServiceRegistration(
  options: UseEditorServiceRegistrationOptions
): EditorServiceRegistrationResult {
  const { registerWithService = true } = options;

  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  const [totalLines, setTotalLines] = useState(0);

  const handleCreateEditor = useCallback(
    (view: EditorView) => {
      if (registerWithService) {
        EditorService.setEditorView(view);
      }
      setScrollElement(view.scrollDOM);
      setTotalLines(view.state.doc.lines);
    },
    [registerWithService]
  );

  useEffect(() => {
    return () => {
      if (registerWithService) {
        EditorService.clearEditorView();
      }
    };
  }, [registerWithService]);

  return {
    handleCreateEditor,
    scrollElement,
    totalLines,
  };
}
