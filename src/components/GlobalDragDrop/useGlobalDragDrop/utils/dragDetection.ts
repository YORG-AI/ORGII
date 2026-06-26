/**
 * Drag detection utilities for GlobalDragDrop
 *
 * Detects internal vs external drag operations
 */
import type { MutableRefObject } from "react";

import { reorderActiveRef } from "@src/engines/ChatPanel/InputArea/components/QueuedMessages";
import {
  isInternalFileTreeDragActive,
  isWorkstationTabDragActive,
} from "@src/shared/dnd/dragSideChannel";
import { getNativeFrameScale } from "@src/util/platform/tauri/nativeFrame";

/**
 * Check if a drag event is internal (from our app) vs external (from OS/IDE)
 */
export function isInternalDrag(
  event: Event,
  appGridEditModeRef: MutableRefObject<boolean>,
  workflowDragActiveRef: MutableRefObject<boolean>
): boolean {
  const dragEvent = event as DragEvent;

  // Queue reorder drag is always internal
  if (reorderActiveRef.current) {
    return true;
  }

  // If app grid is in edit mode, assume any drag could be internal
  // If workflow is dragging, assume any drag could be internal
  if (appGridEditModeRef.current || workflowDragActiveRef.current) {
    return true;
  }

  // Check global flag for internal file tree drags (reliable in Tauri WebView
  // where custom MIME types may not appear in dataTransfer.types)
  if (isInternalFileTreeDragActive()) {
    return true;
  }

  // WorkStation tab drags use dnd-kit pointer events (no DataTransfer), so
  // we detect them via a global flag set in useTabDrag.
  if (isWorkstationTabDragActive()) {
    return true;
  }

  const files = dragEvent.dataTransfer?.files;
  const rawTypes = dragEvent.dataTransfer?.types;
  const types = rawTypes ? Array.from(rawTypes) : [];
  // Check for VS Code tab drag (has vscode-resource or code-resource URI)
  if (types.length > 0) {
    const plainText = dragEvent.dataTransfer?.getData("text/plain");
    const uriList = dragEvent.dataTransfer?.getData("text/uri-list");
    // If it's a vscode:// or file:// URI from VS Code tab drag
    if (
      plainText &&
      (plainText.includes("vscode://") || plainText.includes("file://"))
    ) {
      return false; // NOT internal - we want to handle this
    }

    if (
      uriList &&
      (uriList.includes("vscode://") || uriList.includes("file://"))
    ) {
      return false; // NOT internal - we want to handle this
    }
  }

  // Check if drag contains actual Files (from OS) - these are NOT internal
  if (files && files.length > 0) {
    return false;
  }

  // Check dataTransfer types for known internal drag types
  if (types.length > 0) {
    // Known internal drag types
    if (
      types.includes("application/x-app-grid-item") ||
      types.includes("application/x-workflow-node") ||
      types.includes("application/x-file-reference")
    ) {
      return true;
    }

    // ComposerInput file pills drag as text/html - treat as internal
    if (
      types.includes("text/html") &&
      !types.includes("Files") &&
      types.length <= 2
    ) {
      return true;
    }
  }
  return false;
}

const CHAT_DROP_TARGET_SELECTOR = "[data-chat-drop-target]";
const CHAT_DROP_TARGET_HIT_SLOP_PX = 240;

function getExpandedChatDropTarget(
  coordinateX: number,
  coordinateY: number
): HTMLElement | null {
  const dropTargets = document.querySelectorAll<HTMLElement>(
    CHAT_DROP_TARGET_SELECTOR
  );
  let nearestTarget: HTMLElement | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;

  Array.from(dropTargets).forEach((dropTarget) => {
    const rect = dropTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    if (
      coordinateX < rect.left - CHAT_DROP_TARGET_HIT_SLOP_PX ||
      coordinateX > rect.right + CHAT_DROP_TARGET_HIT_SLOP_PX ||
      coordinateY < rect.top - CHAT_DROP_TARGET_HIT_SLOP_PX ||
      coordinateY > rect.bottom + CHAT_DROP_TARGET_HIT_SLOP_PX
    ) {
      return;
    }

    const nearestX = Math.max(rect.left, Math.min(coordinateX, rect.right));
    const nearestY = Math.max(rect.top, Math.min(coordinateY, rect.bottom));
    const deltaX = coordinateX - nearestX;
    const deltaY = coordinateY - nearestY;
    const distance = deltaX * deltaX + deltaY * deltaY;

    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestTarget = dropTarget;
    }
  });

  return nearestTarget;
}

function isPointInsideChatDropTarget(
  coordinateX: number,
  coordinateY: number
): boolean {
  return getExpandedChatDropTarget(coordinateX, coordinateY) !== null;
}

function getNativeDragPositionScales(): number[] {
  const devicePixelRatio = window.devicePixelRatio || 1;
  const nativeFrameScale = getNativeFrameScale();
  return Array.from(
    new Set([
      devicePixelRatio * nativeFrameScale,
      nativeFrameScale,
      devicePixelRatio,
      1,
    ])
  ).filter((scale) => Number.isFinite(scale) && scale > 0);
}

function getDomViewportPositionCandidates(position: {
  x: number;
  y: number;
}): Array<{
  x: number;
  y: number;
}> {
  return getNativeDragPositionScales().map((scale) => ({
    x: position.x / scale,
    y: position.y / scale,
  }));
}

function getDropTargetElement(
  eventOrPosition: Event | { x: number; y: number }
): Element | null {
  if (eventOrPosition instanceof Event) {
    const target = eventOrPosition.target;
    return target instanceof Element ? target : null;
  }

  for (const domPosition of getDomViewportPositionCandidates(eventOrPosition)) {
    const scaledElement = document.elementFromPoint(
      domPosition.x,
      domPosition.y
    );
    if (scaledElement) return scaledElement;
  }

  return null;
}

export function getChatDropTargetId(
  eventOrPosition: Event | { x: number; y: number }
): string | undefined {
  const targetElement = getDropTargetElement(eventOrPosition);
  const directTarget = targetElement?.closest(CHAT_DROP_TARGET_SELECTOR);
  if (directTarget instanceof HTMLElement) {
    return directTarget.dataset.chatDropTargetId;
  }

  if (eventOrPosition instanceof DragEvent) {
    return getExpandedChatDropTarget(
      eventOrPosition.clientX,
      eventOrPosition.clientY
    )?.dataset.chatDropTargetId;
  }

  if (!(eventOrPosition instanceof Event)) {
    for (const domPosition of getDomViewportPositionCandidates(
      eventOrPosition
    )) {
      const expandedTarget = getExpandedChatDropTarget(
        domPosition.x,
        domPosition.y
      );
      if (expandedTarget) return expandedTarget.dataset.chatDropTargetId;
    }
  }

  return undefined;
}

export function isDropInsideChatDropTarget(
  eventOrPosition: Event | { x: number; y: number }
): boolean {
  const targetElement = getDropTargetElement(eventOrPosition);
  if (targetElement?.closest(CHAT_DROP_TARGET_SELECTOR)) return true;

  if (eventOrPosition instanceof DragEvent) {
    return isPointInsideChatDropTarget(
      eventOrPosition.clientX,
      eventOrPosition.clientY
    );
  }

  if (!(eventOrPosition instanceof Event)) {
    return getDomViewportPositionCandidates(eventOrPosition).some(
      (domPosition) => isPointInsideChatDropTarget(domPosition.x, domPosition.y)
    );
  }

  return false;
}

/**
 * Prevent default behavior for drag events, with special handling for different scenarios
 */
export function createPreventDefaults(
  isInternalDragFn: (e: Event) => boolean
): (e: Event) => void {
  return (event: Event) => {
    // Queue reorder drag — never intercept
    if (reorderActiveRef.current) return;

    const dragEvent = event as DragEvent;
    const rawTypes = dragEvent.dataTransfer?.types;
    const types = rawTypes ? Array.from(rawTypes) : [];

    // CRITICAL: Check for internal file tree drag FIRST.
    // Check the global flag *before* type checks because Tauri's WebView
    // may not expose custom MIME types (application/x-file-reference) in
    // dataTransfer.types at the window capture level. Without this guard,
    // the text/uri-list fallback below calls stopImmediatePropagation(),
    // preventing handleDrop on document from ever firing.
    const isInternalFileTreeDrag = isInternalFileTreeDragActive();

    // WorkStation tab drags use dnd-kit (no DataTransfer); prevent default
    // so the browser doesn't try to navigate, but let them through so
    // the InputArea container-level drop handler can process them.
    const isWorkstationTabDrag = isWorkstationTabDragActive();

    if (
      isInternalFileTreeDrag ||
      isWorkstationTabDrag ||
      types.includes("application/x-file-reference")
    ) {
      event.preventDefault();
      return;
    }

    // Don't prevent internal drag operations (file-tree reorder, app grid, etc.)
    if (isInternalDragFn(event)) {
      return;
    }

    // For any other drag (OS files, IDE URIs, plain drags), suppress the
    // browser's default behavior (navigate to file, open image, etc.) so the
    // real handleDrop listener can process it. We deliberately do NOT call
    // stopImmediatePropagation here — that would also kill the handleDrop
    // listener registered on the same target/phase.
    event.preventDefault();
  };
}
