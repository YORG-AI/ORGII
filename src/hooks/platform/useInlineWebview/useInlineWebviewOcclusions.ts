import { invoke } from "@tauri-apps/api/core";
import { useAtomValue } from "jotai";
import { type RefObject, useCallback, useEffect, useRef } from "react";

import { createLogger } from "@src/hooks/logger";
import { overlayOcclusionStateAtom } from "@src/store/ui/overlayLayerAtom";
import { isMacOS } from "@src/util/platform/tauri";
import { getNativeFrameScale } from "@src/util/platform/tauri/nativeFrame";

import {
  DEFAULT_HOLE_INFLATION_CSS,
  MODAL_HOLE_INFLATION_CSS,
  computeNativeWebviewOcclusions,
} from "./nativeWebviewOcclusion";
import { getVisibleWebviewRect } from "./visibleWebviewRect";
import {
  WEBVIEW_LAYOUT_CHANGED_EVENT,
  WEBVIEW_NATIVE_FRAME_UPDATED_EVENT,
  type WebviewNativeFrameUpdatedDetail,
} from "./webviewLayoutEvents";

const log = createLogger("InlineWebviewOcclusions");

export interface UseInlineWebviewOcclusionsParams {
  containerRef: RefObject<HTMLDivElement | null>;
  isWebviewCreated: boolean;
  isSurfaceVisible: boolean;
  label: string;
}

interface DesiredOcclusionState {
  revision: number;
  maskRects: ReturnType<typeof computeNativeWebviewOcclusions>;
  dimHoleRects: ReturnType<typeof computeNativeWebviewOcclusions>;
  blockInput: boolean;
  dimmingAlpha: number;
}

function samePayload(
  left: DesiredOcclusionState | null,
  right: DesiredOcclusionState
): boolean {
  if (
    !left ||
    left.blockInput !== right.blockInput ||
    left.dimmingAlpha !== right.dimmingAlpha
  ) {
    return false;
  }
  for (const rects of ["maskRects", "dimHoleRects"] as const) {
    if (left[rects].length !== right[rects].length) return false;
    if (
      !left[rects].every((rect, index) => {
        const candidate = right[rects][index];
        return (
          rect.x === candidate.x &&
          rect.y === candidate.y &&
          rect.width === candidate.width &&
          rect.height === candidate.height
        );
      })
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Projects the global React overlay registry into one native browser surface.
 * IPC is latest-wins and serialized so a late open/close response cannot
 * restore a stale mask.
 */
export function useInlineWebviewOcclusions({
  containerRef,
  isWebviewCreated,
  isSurfaceVisible,
  label,
}: UseInlineWebviewOcclusionsParams): void {
  const overlayState = useAtomValue(overlayOcclusionStateAtom);
  const desiredRef = useRef<DesiredOcclusionState>({
    revision: 0,
    maskRects: [],
    dimHoleRects: [],
    blockInput: false,
    dimmingAlpha: 0,
  });
  // Native surfaces start with no mask/input block. Seeding that projection
  // avoids one no-op IPC for every restored but inactive browser session.
  const appliedRef = useRef<DesiredOcclusionState | null>({
    revision: 0,
    maskRects: [],
    dimHoleRects: [],
    blockInput: false,
    dimmingAlpha: 0,
  });
  const applyingRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  const measureDesired = useCallback((): DesiredOcclusionState => {
    const revision = desiredRef.current.revision + 1;
    if (!isWebviewCreated || !isSurfaceVisible || !containerRef.current) {
      return {
        revision,
        maskRects: [],
        dimHoleRects: [],
        blockInput: false,
        dimmingAlpha: 0,
      };
    }

    const surface = getVisibleWebviewRect(containerRef.current);
    if (!surface) {
      return {
        revision,
        maskRects: [],
        dimHoleRects: [],
        blockInput: false,
        dimmingAlpha: 0,
      };
    }

    const holeInflationCss =
      overlayState.nativeDimmingAlpha > 0
        ? MODAL_HOLE_INFLATION_CSS
        : DEFAULT_HOLE_INFLATION_CSS;

    return {
      revision,
      maskRects: computeNativeWebviewOcclusions(
        surface,
        overlayState.maskRects,
        getNativeFrameScale(),
        { holeInflationCss }
      ),
      dimHoleRects: computeNativeWebviewOcclusions(
        surface,
        overlayState.dimHoleRects,
        getNativeFrameScale(),
        { holeInflationCss }
      ),
      blockInput: overlayState.blocksNativeInput,
      dimmingAlpha: overlayState.nativeDimmingAlpha,
    };
  }, [
    containerRef,
    isSurfaceVisible,
    isWebviewCreated,
    overlayState.blocksNativeInput,
    overlayState.dimHoleRects,
    overlayState.maskRects,
    overlayState.nativeDimmingAlpha,
  ]);

  const applyLatest = useCallback(async () => {
    if (applyingRef.current || !isMacOS()) return;
    applyingRef.current = true;
    let failedRevision: number | null = null;

    try {
      while (
        mountedRef.current &&
        appliedRef.current?.revision !== desiredRef.current.revision
      ) {
        const desired = desiredRef.current;
        if (samePayload(appliedRef.current, desired)) {
          appliedRef.current = desired;
          continue;
        }

        try {
          await invoke("set_inline_webview_occlusions", {
            label,
            rects: desired.maskRects,
            dimHoleRects: desired.dimHoleRects,
            blockInput: desired.blockInput,
            dimmingAlpha: desired.dimmingAlpha,
          });
        } catch (error) {
          failedRevision = desired.revision;
          log.warn("Failed to apply native WebView occlusions:", error);
          break;
        }

        appliedRef.current = desired;
      }
    } finally {
      applyingRef.current = false;
      if (
        mountedRef.current &&
        desiredRef.current.revision !== appliedRef.current?.revision &&
        desiredRef.current.revision !== failedRevision
      ) {
        void applyLatest();
      }
    }
  }, [label]);

  const publish = useCallback(() => {
    desiredRef.current = measureDesired();
    void applyLatest();
  }, [applyLatest, measureDesired]);

  const schedulePublish = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      publish();
    });
  }, [publish]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    publish();
  }, [publish]);

  useEffect(() => {
    if (
      !isMacOS() ||
      !isWebviewCreated ||
      !isSurfaceVisible ||
      (overlayState.maskRects.length === 0 &&
        overlayState.dimHoleRects.length === 0 &&
        overlayState.nativeDimmingAlpha === 0)
    ) {
      return;
    }

    const element = containerRef.current;
    const resizeObserver =
      element && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(schedulePublish)
        : null;
    if (element) resizeObserver?.observe(element);

    window.addEventListener("resize", schedulePublish);
    window.addEventListener("scroll", schedulePublish, true);
    window.addEventListener(WEBVIEW_LAYOUT_CHANGED_EVENT, schedulePublish);
    const handleNativeFrameUpdated = (event: Event) => {
      const detail = (event as CustomEvent<WebviewNativeFrameUpdatedDetail>)
        .detail;
      if (detail?.label === label) schedulePublish();
    };
    window.addEventListener(
      WEBVIEW_NATIVE_FRAME_UPDATED_EVENT,
      handleNativeFrameUpdated
    );

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", schedulePublish);
      window.removeEventListener("scroll", schedulePublish, true);
      window.removeEventListener(WEBVIEW_LAYOUT_CHANGED_EVENT, schedulePublish);
      window.removeEventListener(
        WEBVIEW_NATIVE_FRAME_UPDATED_EVENT,
        handleNativeFrameUpdated
      );
    };
  }, [
    containerRef,
    isSurfaceVisible,
    isWebviewCreated,
    label,
    overlayState.dimHoleRects.length,
    overlayState.maskRects.length,
    overlayState.nativeDimmingAlpha,
    schedulePublish,
  ]);

  useEffect(() => {
    return () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      if (isMacOS() && isWebviewCreated) {
        void invoke("set_inline_webview_occlusions", {
          label,
          rects: [],
          dimHoleRects: [],
          blockInput: false,
          dimmingAlpha: 0,
        }).catch(() => undefined);
      }
    };
  }, [isWebviewCreated, label]);
}
