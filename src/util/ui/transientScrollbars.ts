export const TRANSIENT_SCROLLBAR_ATTRIBUTE = "data-scrollbar-scrolling";
export const TRANSIENT_SCROLLBAR_HIDE_DELAY_MS = 900;

interface TransientScrollbarController {
  ownerDocument: Document;
  dispose: () => void;
  reveal: (element: Element) => void;
  clear: (element: Element) => void;
}

let installedController: TransientScrollbarController | null = null;

function resolveScrollTarget(
  ownerDocument: Document,
  target: EventTarget | null
): Element | null {
  if (target instanceof Element) return target;
  return target === ownerDocument ? ownerDocument.scrollingElement : null;
}

/**
 * Installs one app-wide scroll activity observer.
 *
 * Native scroll events do not bubble, so the capture listener is intentional:
 * it covers dropdowns, editors, and nested panels without one listener per
 * scroll area. Activity owns at most one element and one timeout at a time.
 */
export function installTransientScrollbars(
  ownerDocument: Document = document
): () => void {
  if (installedController) return installedController.dispose;

  let activeElement: Element | null = null;
  let lastActivityAt = 0;
  let hideTimeout: ReturnType<typeof setTimeout> | null = null;

  const hideActive = () => {
    if (hideTimeout) {
      clearTimeout(hideTimeout);
      hideTimeout = null;
    }
    activeElement?.removeAttribute(TRANSIENT_SCROLLBAR_ATTRIBUTE);
    activeElement = null;
  };

  const scheduleHide = () => {
    if (hideTimeout) return;

    const checkActivity = () => {
      hideTimeout = null;
      const remaining =
        TRANSIENT_SCROLLBAR_HIDE_DELAY_MS - (Date.now() - lastActivityAt);
      if (remaining > 0) {
        hideTimeout = setTimeout(checkActivity, remaining);
        return;
      }
      hideActive();
    };

    hideTimeout = setTimeout(checkActivity, TRANSIENT_SCROLLBAR_HIDE_DELAY_MS);
  };

  const reveal = (element: Element) => {
    if (element.ownerDocument !== ownerDocument) return;
    if (ownerDocument.visibilityState === "hidden") {
      hideActive();
      return;
    }

    lastActivityAt = Date.now();
    if (activeElement !== element) {
      activeElement?.removeAttribute(TRANSIENT_SCROLLBAR_ATTRIBUTE);
      activeElement = element;
      activeElement.setAttribute(TRANSIENT_SCROLLBAR_ATTRIBUTE, "");
    }
    scheduleHide();
  };

  const clear = (element: Element) => {
    if (activeElement === element) {
      hideActive();
      return;
    }
    element.removeAttribute(TRANSIENT_SCROLLBAR_ATTRIBUTE);
  };

  const handleScroll = (event: Event) => {
    const element = resolveScrollTarget(ownerDocument, event.target);
    if (element) reveal(element);
  };

  const handleVisibilityChange = () => {
    if (ownerDocument.visibilityState === "hidden") hideActive();
  };

  ownerDocument.addEventListener("scroll", handleScroll, {
    capture: true,
    passive: true,
  });
  ownerDocument.addEventListener("visibilitychange", handleVisibilityChange);

  const dispose = () => {
    ownerDocument.removeEventListener("scroll", handleScroll, true);
    ownerDocument.removeEventListener(
      "visibilitychange",
      handleVisibilityChange
    );
    hideActive();
    if (installedController?.dispose === dispose) installedController = null;
  };

  installedController = { ownerDocument, dispose, reveal, clear };
  return dispose;
}

/** Reveal a custom overlay scrollbar through the same bounded activity state. */
export function revealTransientScrollbar(element: Element): void {
  installedController?.reveal(element);
}

/** Release a custom overlay scrollbar immediately when its owner unmounts. */
export function clearTransientScrollbar(element: Element): void {
  installedController?.clear(element);
}
