/**
 * useAddToAgentInsertion
 *
 * Shared hook consumed by both the active-session InputArea and the
 * SessionCreator. Watches `addToAgentAtom` for pending context requests
 * written by WorkStation surfaces, inserts the appropriate pill/reference
 * into the provided ComposerInput ref, and then clears the atom.
 *
 * A scheduled retry loop handles both React's passive-effect timing and the
 * case where ComposerInput hasn't finished initialising yet (e.g. the chat panel just
 * opened and the ref is still null on the first render).
 */
import { useAtomValue, useSetAtom } from "jotai";
import { type RefObject, useEffect } from "react";

import type { ComposerInputRef } from "@src/components/ComposerInput";
import { capPillText, storePillText } from "@src/config/pillTokens";
import { addToAgentAtom } from "@src/store/ui/addToAgentAtom";

export function useAddToAgentInsertion(
  composerInputRef: RefObject<ComposerInputRef | null>
): void {
  const request = useAtomValue(addToAgentAtom);
  const clearRequest = useSetAtom(addToAgentAtom);

  useEffect(() => {
    if (!request) return;

    const stableRequest = request;
    let cancelled = false;
    let retryTimeoutId: ReturnType<typeof setTimeout> | null = null;

    function scheduleInsert(delayMs: number) {
      retryTimeoutId = setTimeout(tryInsert, delayMs);
    }

    function tryInsert() {
      if (cancelled) return;
      retryTimeoutId = null;

      const editor = composerInputRef.current;
      if (!editor) {
        scheduleInsert(50);
        return;
      }

      if (stableRequest.type === "lines") {
        editor.insertFileReference({
          filePath: stableRequest.filePath,
          fileName: stableRequest.fileName,
          lineStart: stableRequest.lineStart,
          lineEnd: stableRequest.lineEnd,
        });
      } else if (stableRequest.type === "terminal") {
        const capped = capPillText(stableRequest.text);
        const pillPath = `terminal://selection/${Date.now()}`;
        let label: string;
        if (stableRequest.displayName) {
          label = stableRequest.displayName;
        } else if (
          stableRequest.lineStart !== undefined &&
          stableRequest.lineEnd !== undefined
        ) {
          label =
            stableRequest.lineStart === stableRequest.lineEnd
              ? `Terminal (${stableRequest.lineStart})`
              : `Terminal (${stableRequest.lineStart}-${stableRequest.lineEnd})`;
        } else {
          const lineCount = capped.trimEnd().split("\n").length;
          label = lineCount > 1 ? `Terminal (1-${lineCount})` : "Terminal";
        }
        storePillText(pillPath, capped);
        editor.insertFilePill(pillPath, false, "terminal", label);
      } else if (stableRequest.type === "dom-element") {
        const pillPath = `dom-element://selection/${Date.now()}`;
        storePillText(pillPath, capPillText(stableRequest.text));
        editor.insertFilePill(
          pillPath,
          false,
          "dom-element",
          stableRequest.displayName
        );
      } else if (stableRequest.type === "dom-component") {
        const pillPath = `paste://${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)}`;
        storePillText(pillPath, capPillText(stableRequest.jsonText));
        editor.insertFilePill(
          pillPath,
          false,
          "dom-component",
          stableRequest.fileName
        );
      } else if (stableRequest.type === "issue") {
        const pillPath = `issue://${stableRequest.issueNumber}`;
        const label = `#${stableRequest.issueNumber} ${stableRequest.issueTitle}`;
        storePillText(pillPath, capPillText(JSON.stringify(stableRequest)));
        editor.insertFilePill(pillPath, false, "issue", label);
      } else if (stableRequest.type === "pr") {
        const pillPath = `pr://${stableRequest.prNumber}`;
        const label = `PR #${stableRequest.prNumber} ${stableRequest.prTitle}`;
        storePillText(pillPath, capPillText(JSON.stringify(stableRequest)));
        editor.insertFilePill(pillPath, false, "pr", label);
      } else {
        editor.insertFilePill(stableRequest.filePath, false, "file");
      }

      editor.focus();
      clearRequest(null);
    }

    scheduleInsert(0);

    return () => {
      cancelled = true;
      if (retryTimeoutId !== null) clearTimeout(retryTimeoutId);
    };
  }, [request, composerInputRef, clearRequest]);
}
