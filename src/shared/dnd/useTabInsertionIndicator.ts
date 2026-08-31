import { type RefObject, useEffect } from "react";

interface UseTabInsertionIndicatorOptions {
  /** The same content band filled by the rectangular drop highlight. */
  containerRef: RefObject<HTMLElement | null>;
  draggingTabId: string | null;
}

/** Drag-only insertion feedback shared by the Workstation and Chat Panel. */
export function useTabInsertionIndicator({
  containerRef,
  draggingTabId,
}: UseTabInsertionIndicatorOptions): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!draggingTabId || !container) return;

    const indicator = document.createElement("div");
    indicator.className = "tab-insertion-indicator";
    indicator.setAttribute("aria-hidden", "true");
    indicator.style.cssText = `
      position: fixed;
      left: 0;
      top: 0;
      width: 2px;
      background: var(--color-primary-6);
      border-radius: 1px;
      z-index: 10000;
      pointer-events: none;
      display: none;
      box-shadow: 0 0 4px color-mix(in srgb, var(--color-primary-6) 50%, transparent);
      will-change: transform;
      contain: layout style;
    `;
    document.body.appendChild(indicator);

    let frameId: number | null = null;
    let pointer: { x: number; y: number } | null = null;

    const hideIndicator = () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
        frameId = null;
      }
      indicator.style.display = "none";
    };

    const updateIndicator = () => {
      frameId = null;
      if (!pointer || document.visibilityState === "hidden") return;

      // Measure the content band, not the header's window-edge padding.
      const bounds = container.getBoundingClientRect();
      if (
        bounds.width <= 0 ||
        bounds.height <= 0 ||
        pointer.x < bounds.left ||
        pointer.x > bounds.right ||
        pointer.y < bounds.top ||
        pointer.y > bounds.bottom
      ) {
        hideIndicator();
        return;
      }

      const tabs = container.querySelectorAll<HTMLElement>("[data-tab-id]");
      let indicatorX = bounds.left;
      for (const tab of tabs) {
        const tabBounds = tab.getBoundingClientRect();
        if (
          tab.dataset.tabId !== draggingTabId &&
          pointer.x < tabBounds.left + tabBounds.width / 2
        ) {
          indicatorX = tabBounds.left - 1;
          break;
        }
        indicatorX = tabBounds.right - 1;
      }

      // A scrolled tab edge must not paint over the adjacent header buttons.
      indicatorX = Math.max(
        bounds.left,
        Math.min(indicatorX, bounds.right - 2)
      );
      indicator.style.height = `${bounds.height}px`;
      indicator.style.transform = `translate3d(${indicatorX}px, ${bounds.top}px, 0)`;
      indicator.style.display = "block";
    };

    const scheduleUpdate = () => {
      if (
        pointer &&
        frameId === null &&
        document.visibilityState !== "hidden"
      ) {
        frameId = requestAnimationFrame(updateIndicator);
      }
    };
    const handlePointerMove = (event: PointerEvent) => {
      pointer = { x: event.clientX, y: event.clientY };
      scheduleUpdate();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") hideIndicator();
      else scheduleUpdate();
    };

    document.addEventListener("pointermove", handlePointerMove, {
      passive: true,
    });
    container.addEventListener("scroll", scheduleUpdate, {
      passive: true,
      capture: true,
    });
    window.addEventListener("resize", scheduleUpdate, { passive: true });
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("pointermove", handlePointerMove);
      container.removeEventListener("scroll", scheduleUpdate, true);
      window.removeEventListener("resize", scheduleUpdate);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      hideIndicator();
      indicator.remove();
    };
  }, [containerRef, draggingTabId]);
}
