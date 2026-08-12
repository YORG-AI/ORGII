/**
 * Pill portal rendering for ComposerInput.
 *
 * Builds a `createPortal` for each live pill DOM span so `ComposerPill`
 * renders inside the `contenteditable="false"` host span (the DOM owns
 * document order for Selection/Range purposes; React owns the pill UI).
 * Also owns the post-insert caret correction that runs once a newly
 * inserted pill's span has been committed to the DOM.
 */
import { useLayoutEffect } from "react";
import { createPortal } from "react-dom";

import ComposerPill from "./ComposerPill";
import { placeCaretAfterPill } from "./selection";
import type {
  PillEntry,
  UseEditorOperationsResult,
} from "./useEditorOperations";
import { extractPlainText } from "./utils";

export interface UseComposerPillPortalsParams {
  ops: UseEditorOperationsResult;
  pillEntries: PillEntry[];
  skillPathByName: Map<string, string>;
  updateEmptyState: () => void;
  onContentChangeRef: React.RefObject<((text: string) => void) | undefined>;
  pendingCaretAfterPillRef: React.MutableRefObject<boolean>;
}

/**
 * Renders one React Portal per live pill span, plus the caret-after-insert
 * layout correction. Extracted verbatim from `ComposerInput/index.tsx`.
 */
export function useComposerPillPortals({
  ops,
  pillEntries,
  skillPathByName,
  updateEmptyState,
  onContentChangeRef,
  pendingCaretAfterPillRef,
}: UseComposerPillPortalsParams) {
  const { hostRef } = ops;

  const pillPortals = pillEntries.map((entry) => {
    const target = ops.hostRef.current?.querySelector(
      `[data-pill-id="${entry.id}"]`
    ) as HTMLSpanElement | null;
    if (!target) return null;
    ops.registerPillHost(entry.id, target);
    return createPortal(
      <ComposerPill
        attrs={entry.attrs}
        skillPath={
          entry.attrs.iconType === "skill"
            ? (skillPathByName.get(entry.attrs.filePath) ??
              skillPathByName.get(entry.attrs.fileName))
            : undefined
        }
        onDelete={() => {
          ops.markHistoryBoundary();
          const host = ops.hostRef.current;
          const parent = target.parentNode;
          const previousSibling = target.previousSibling;
          parent?.removeChild(target);
          if (host && parent) {
            const range = document.createRange();
            // Walk left past any empty sentinel text nodes to find real content.
            // If nothing is to the left, fall back to end of parent (after the
            // last remaining child) so the caret never snaps to position 0.
            let placed = false;
            let node: ChildNode | null = previousSibling as ChildNode | null;
            while (node) {
              if (
                node.nodeType === Node.TEXT_NODE &&
                (node.textContent ?? "").length > 0 &&
                parent.contains(node)
              ) {
                range.setStart(node, (node.textContent ?? "").length);
                placed = true;
                break;
              }
              node = node.previousSibling;
            }
            if (!placed) {
              range.setStart(parent, parent.childNodes.length);
            }
            range.collapse(true);
            const selection = window.getSelection();
            if (selection) {
              host.focus({ preventScroll: true });
              selection.removeAllRanges();
              selection.addRange(range);
            }
          }
          ops.reconcilePillsFromDom();
          ops.commitHistoryBoundary();
          updateEmptyState();
          if (host) onContentChangeRef.current?.(extractPlainText(host));
        }}
      />,
      target,
      entry.id
    );
  });

  useLayoutEffect(() => {
    if (!pendingCaretAfterPillRef.current) return;

    const liveHost = hostRef.current;
    if (!liveHost) return;
    const insertedPill = liveHost.querySelector<HTMLElement>(
      "[data-last-inserted-pill]"
    );
    if (!insertedPill) return;

    // Layout effects run before paint. Keep this correction synchronous so
    // embedded layout changes cannot expose a one-frame caret jump.
    placeCaretAfterPill(insertedPill);
    insertedPill.removeAttribute("data-last-inserted-pill");
    pendingCaretAfterPillRef.current = false;
    // pendingCaretAfterPillRef is a stable ref passed in from the parent —
    // listing it would not change behavior, only silence the linter's
    // inability to see it originates from a `useRef()` in this scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostRef, pillEntries]);

  return pillPortals;
}
