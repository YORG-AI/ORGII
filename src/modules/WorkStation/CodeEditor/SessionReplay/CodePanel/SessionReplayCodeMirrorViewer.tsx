/**
 * Read-only CodeMirror viewer for session replay file display.
 * Uses the same editor theme, typography, and syntax highlighting as the real code editor.
 */
import { useSetAtom } from "jotai";
import React, { memo, useCallback, useMemo, useState } from "react";

import {
  CodeMirrorEditor,
  type TextSelectionInfo,
} from "@src/features/CodeMirror";
import { TextSelectionDropdown } from "@src/scaffold/ContextMenu/exports";
import { addToAgentAtom } from "@src/store/ui/addToAgentAtom";
import { getFileName } from "@src/util/file/pathUtils";

export interface SessionReplayCodeMirrorViewerProps {
  content: string;
  filePath?: string;
  language?: string;
  /** 1-indexed file line of the first content line (ranged reads). */
  startLine?: number;
}

export const SessionReplayCodeMirrorViewer: React.FC<SessionReplayCodeMirrorViewerProps> =
  memo(({ content, filePath, language, startLine }) => {
    const setAddToAgent = useSetAtom(addToAgentAtom);
    const [selection, setSelection] = useState<TextSelectionInfo | null>(null);
    const fileName = filePath ? getFileName(filePath) : "";
    const lineOffset = (startLine ?? 1) - 1;
    const lineRange = useMemo(
      () =>
        selection
          ? {
              fromLine: selection.fromLine + lineOffset,
              toLine: selection.toLine + lineOffset,
            }
          : null,
      [lineOffset, selection]
    );

    const handleTextSelection = useCallback(
      (nextSelection: TextSelectionInfo | null) => {
        setSelection(nextSelection);
      },
      []
    );

    const handleCloseDropdown = useCallback(() => {
      setSelection(null);
    }, []);

    const handleAddFile = useCallback(() => {
      if (!filePath) return;
      setAddToAgent({
        type: "file",
        filePath,
        fileName,
      });
    }, [fileName, filePath, setAddToAgent]);

    const handleAddLines = useCallback(() => {
      if (!filePath || !lineRange) return;
      setAddToAgent({
        type: "lines",
        filePath,
        fileName,
        lineStart: lineRange.fromLine,
        lineEnd: lineRange.toLine,
      });
    }, [fileName, filePath, lineRange, setAddToAgent]);

    return (
      <div className="h-full min-h-0 min-w-0 overflow-hidden [&_.codemirror-editor-wrapper]:h-full">
        <CodeMirrorEditor
          value={content}
          filePath={filePath}
          language={language}
          height="100%"
          readOnly
          enableMinimap={false}
          enableLinting={false}
          enableDirtyDiff={false}
          registerWithService={false}
          enableGitBlame={false}
          lineNumberStart={startLine}
          onTextSelection={filePath ? handleTextSelection : undefined}
        />
        <TextSelectionDropdown
          visible={Boolean(filePath && selection && lineRange)}
          position={selection?.position ?? { x: 0, y: 0 }}
          selectedText={selection?.text ?? ""}
          source="editor"
          onClose={handleCloseDropdown}
          onAddFile={handleAddFile}
          onAddLines={handleAddLines}
          lineRange={lineRange ?? undefined}
        />
      </div>
    );
  });

SessionReplayCodeMirrorViewer.displayName = "SessionReplayCodeMirrorViewer";
