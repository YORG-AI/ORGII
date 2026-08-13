import type { RefObject } from "react";

import type {
  ComposerInputRef,
  PillIconType,
} from "@src/components/ComposerInput";
import Message from "@src/components/Message";
import { capPillText, storePillText } from "@src/config/pillTokens";
import { parseCloudSessionReference } from "@src/features/Org2Cloud/cloudSessionReference";
import { referenceInsertText } from "@src/features/Org2Cloud/referenceInsertText";
import i18n from "@src/i18n";
import { loadWorkItemPillContent } from "@src/util/contextPillContent";

export const CHAT_DROP_TARGET_SELECTOR = "[data-chat-drop-target]";

export function resolveDropTarget(
  containerRef: RefObject<HTMLElement | null>
): HTMLElement | null {
  if (!containerRef.current) return null;
  return containerRef.current.matches(CHAT_DROP_TARGET_SELECTOR)
    ? containerRef.current
    : containerRef.current.querySelector<HTMLElement>(
        CHAT_DROP_TARGET_SELECTOR
      );
}

export function isPointerOverDropTarget(
  containerRef: RefObject<HTMLElement | null>,
  x: number,
  y: number
): boolean {
  const dropTarget = resolveDropTarget(containerRef);
  if (!dropTarget) return false;
  const rect = dropTarget.getBoundingClientRect();
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

interface InsertPillOptions {
  path: string;
  name?: string;
  iconType?: PillIconType;
  isFolder?: boolean;
  pointerX?: number;
  pointerY?: number;
  contextText?: string;
  /** Suppress the toast when a caller inserts several pills as one action. */
  notify?: boolean;
}

function getDisplayName(path: string, name: string | undefined): string {
  return name ?? path.split("/").pop() ?? path;
}

export function insertPillFromTabPayload(
  composerInputRef: RefObject<ComposerInputRef | null>,
  payload: InsertPillOptions
): void {
  if (!composerInputRef.current) return;
  if (!payload.path) return;

  // A teammate's cloud session goes in as reference TEXT, matching what
  // the `@` menu inserts. As a pill it would ride the session-pill path,
  // which assumes a bare local id and mangles the reference in three
  // places: icon lookup, serialization, and the agent context line.
  if (parseCloudSessionReference(payload.path)) {
    composerInputRef.current.insertMentionText(
      referenceInsertText(payload.path)
    );
    return;
  }

  const iconType = payload.iconType ?? (payload.isFolder ? "folder" : "file");
  const isFolder = payload.isFolder ?? iconType === "folder";
  const displayName = getDisplayName(payload.path, payload.name);

  if (payload.contextText && iconType !== "workitem") {
    storePillText(payload.path, capPillText(payload.contextText));
  }

  // Only place the caret at the drop point when the input already has
  // content and is focused — inserting into a position that exists.
  // When the input is empty (or unfocused) the pill will be the first
  // element, so pointer-based placement would produce a visible caret
  // flash before the pill DOM is ready.
  if (
    payload.pointerX != null &&
    payload.pointerY != null &&
    !composerInputRef.current.isEmpty()
  ) {
    composerInputRef.current.placeCaretAtPoint(
      payload.pointerX,
      payload.pointerY
    );
  }

  if (iconType === "workitem") {
    const pillPath = `workitem://${payload.path}/${Date.now()}`;
    if (payload.contextText) {
      storePillText(pillPath, capPillText(payload.contextText));
    }
    composerInputRef.current.insertFilePill(
      pillPath,
      false,
      "workitem",
      displayName
    );
    if (!payload.contextText) {
      loadWorkItemPillContent(payload.path, pillPath);
    }
    if (payload.notify !== false) {
      Message.success(i18n.t("toasts.addedAsContext", { name: displayName }));
    }
    return;
  }

  composerInputRef.current.insertFilePill(
    payload.path,
    isFolder,
    iconType,
    displayName
  );
  if (payload.notify !== false) {
    Message.success(i18n.t("toasts.addedAsContext", { name: displayName }));
  }
}

export function insertTabAsPill(
  composerInputRef: RefObject<ComposerInputRef | null>,
  filePath: string,
  name: string | undefined,
  type: string | undefined
): void {
  insertPillFromTabPayload(composerInputRef, {
    path: filePath,
    name,
    iconType: type === "directory" ? "folder" : "file",
    isFolder: type === "directory",
  });
}
