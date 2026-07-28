/**
 * Accept a dragged sidebar session row on a plain text surface (issue
 * comment box, issue body, work item description) and insert its cloud
 * reference at the caret.
 *
 * The sidebar already emits a pill drag for session rows — the same one the
 * chat composer turns into a context pill — but its payload is the LOCAL
 * `session://<id>` path, which means nothing to anyone else. What belongs in
 * an issue is the cloud reference, so this resolves the org the same way the
 * Copy ID menu item does and declines when it cannot.
 *
 * The drag is pointer-based (a CustomEvent carrying pointer coordinates),
 * not HTML5 dataTransfer, so a drop target is a hit test against the
 * element's rect rather than an `onDrop` handler.
 */
import { useAtomValue, useStore } from "jotai";
import { type RefObject, useCallback, useEffect, useState } from "react";

import Message from "@src/components/Message";
import i18n from "@src/i18n";
import type { TabDragEventDetail } from "@src/modules/WorkStation/shared/TabBar/tabDragTypes";

import { buildCloudSessionReference } from "./cloudSessionReference";
import { org2CloudAuthAtom } from "./org2CloudAuthAtom";
import { sidebarActiveCloudOrgIdAtom } from "./org2CloudOrgsAtom";
import {
  org2CloudPushCursorsAtom,
  org2CloudPushedMetadataAtom,
} from "./org2CloudSyncAtoms";
import {
  SESSION_REFERENCE_ORG,
  publishedOrgIdsForSession,
  resolveSessionReferenceOrg,
} from "./resolveSessionReferenceOrg";

const SESSION_PILL_PREFIX = "session://";

/** Local session id from a dragged pill, or null when it is not a session. */
export function draggedSessionId(detail: TabDragEventDetail): string | null {
  const pill = detail.pill;
  if (pill?.iconType !== "session") return null;
  if (!pill.path.startsWith(SESSION_PILL_PREFIX)) return null;
  return (
    pill.path.slice(SESSION_PILL_PREFIX.length).split("/")[0].trim() || null
  );
}

function isPointInside(
  element: HTMLElement | null,
  x: number | undefined,
  y: number | undefined
): boolean {
  if (!element || x == null || y == null) return false;
  const rect = element.getBoundingClientRect();
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

/** Insert `text` at the caret of a textarea, keeping the caret after it. */
export function insertAtCaret(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  text: string
): { value: string; caret: number } {
  const before = value.slice(0, selectionStart);
  const after = value.slice(selectionEnd);
  const needsLeadingSpace = before.length > 0 && !/\s$/u.test(before);
  const needsTrailingSpace = after.length > 0 && !/^\s/u.test(after);
  const inserted = `${needsLeadingSpace ? " " : ""}${text}${
    needsTrailingSpace ? " " : ""
  }`;
  return {
    value: `${before}${inserted}${after}`,
    caret: before.length + inserted.length,
  };
}

interface UseSessionReferenceDropTargetParams {
  elementRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (next: string) => void;
  enabled?: boolean;
}

export function useSessionReferenceDropTarget({
  elementRef,
  value,
  onChange,
  enabled = true,
}: UseSessionReferenceDropTargetParams): { isDragOver: boolean } {
  const store = useStore();
  const auth = useAtomValue(org2CloudAuthAtom);
  const [isDragOver, setIsDragOver] = useState(false);

  const referenceFor = useCallback(
    (sessionId: string): string | null => {
      const userId = store.get(org2CloudAuthAtom)?.userId;
      if (!userId) return null;
      const resolution = resolveSessionReferenceOrg({
        publishedOrgIds: publishedOrgIdsForSession(
          sessionId,
          store.get(org2CloudPushCursorsAtom),
          store.get(org2CloudPushedMetadataAtom)
        ),
        activeCloudOrgId: store.get(sidebarActiveCloudOrgIdAtom),
      });
      if (resolution.kind !== SESSION_REFERENCE_ORG.RESOLVED) {
        Message.error(
          i18n.t(
            resolution.kind === SESSION_REFERENCE_ORG.UNPUBLISHED
              ? "navigation:cloud.sessionRef.notPublished"
              : "navigation:cloud.sessionRef.chooseOrg"
          )
        );
        return null;
      }
      return buildCloudSessionReference({
        orgId: resolution.orgId,
        ownerUserId: userId,
        sourceSessionId: sessionId,
      });
    },
    [store]
  );

  useEffect(() => {
    if (!enabled || !auth) return undefined;

    const onDragStart = (event: Event) => {
      const detail = (event as CustomEvent<TabDragEventDetail>).detail;
      if (draggedSessionId(detail)) setIsDragOver(false);
    };

    const onDragEnd = (event: Event) => {
      const detail = (event as CustomEvent<TabDragEventDetail>).detail;
      setIsDragOver(false);
      const sessionId = draggedSessionId(detail);
      if (!sessionId) return;
      const element = elementRef.current;
      if (!isPointInside(element, detail.pointerX, detail.pointerY)) return;

      const reference = referenceFor(sessionId);
      if (!reference || !element) return;
      const { value: next, caret } = insertAtCaret(
        value,
        element.selectionStart ?? value.length,
        element.selectionEnd ?? value.length,
        reference
      );
      onChange(next);
      window.requestAnimationFrame(() => {
        element.focus();
        element.setSelectionRange(caret, caret);
      });
    };

    const onPointerMove = (event: PointerEvent) => {
      setIsDragOver(
        isPointInside(elementRef.current, event.clientX, event.clientY)
      );
    };

    document.addEventListener("tab-drag-start", onDragStart);
    document.addEventListener("tab-drag-end", onDragEnd);
    document.addEventListener("pointermove", onPointerMove);
    return () => {
      document.removeEventListener("tab-drag-start", onDragStart);
      document.removeEventListener("tab-drag-end", onDragEnd);
      document.removeEventListener("pointermove", onPointerMove);
    };
  }, [auth, elementRef, enabled, onChange, referenceFor, value]);

  return { isDragOver };
}
