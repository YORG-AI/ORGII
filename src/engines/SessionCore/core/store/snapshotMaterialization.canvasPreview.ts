/**
 * Latest-canvas-preview inference for `snapshotMaterialization.ts`.
 *
 * Detects canvas-inline events and recomputes the most recent canvas
 * preview stored on `NormalizedSnapshotCache` after a delta may have
 * touched (upserted or removed) the event that produced it.
 */
import type { SessionEvent } from "../types";
import type {
  LatestCanvasPreview,
  NormalizedSnapshotCache,
} from "./EventStoreProxyTypes";

export function isCanvasEvent(event: SessionEvent | undefined): boolean {
  return Boolean(
    event &&
    (event.uiCanonical === "canvas_inline" ||
      event.functionName === "render_inline_canvas")
  );
}

function canvasPreviewForEvent(
  event: SessionEvent | undefined
): LatestCanvasPreview | undefined {
  if (!event || !isCanvasEvent(event)) return undefined;
  const args = event.args as Record<string, unknown>;
  return {
    eventId: event.id,
    mode: typeof args.mode === "string" ? args.mode : "html",
    url: typeof args.url === "string" ? args.url : undefined,
    title: typeof args.title === "string" ? args.title : undefined,
    streaming: typeof args.streaming === "boolean" ? args.streaming : undefined,
  } as LatestCanvasPreview;
}

export function recomputeLatestCanvasPreview(
  cache: NormalizedSnapshotCache
): void {
  cache.latestCanvasPreview = undefined;
  for (let index = cache.eventIds.length - 1; index >= 0; index--) {
    const preview = canvasPreviewForEvent(
      cache.eventsById.get(cache.eventIds[index])
    );
    if (preview) {
      cache.latestCanvasPreview = preview;
      return;
    }
  }
}
