import { vi } from "vitest";

/** jsdom has no layout. Supply row/viewport geometry, not a fake virtualizer. */
export function installVirtualListTestLayout() {
  const height = function (this: HTMLElement): number {
    const explicit = Number.parseFloat(this.style.height);
    if (Number.isFinite(explicit)) return explicit;
    if (this.dataset.index !== undefined) {
      const button = this.querySelector("button");
      return button?.classList.contains("min-h-12") ? 48 : 32;
    }
    return 350;
  };
  const offsetHeight = vi
    .spyOn(HTMLElement.prototype, "offsetHeight", "get")
    .mockImplementation(height);
  const clientHeight = vi
    .spyOn(HTMLElement.prototype, "clientHeight", "get")
    .mockImplementation(height);
  const offsetWidth = vi
    .spyOn(HTMLElement.prototype, "offsetWidth", "get")
    .mockReturnValue(420);
  const scrollHeight = vi
    .spyOn(HTMLElement.prototype, "scrollHeight", "get")
    .mockImplementation(function (this: HTMLElement) {
      return Math.max(
        this.clientHeight,
        Number.parseFloat(
          (this.firstElementChild as HTMLElement)?.style.height
        ) || 0
      );
    });
  const previousScrollTo = HTMLElement.prototype.scrollTo;
  HTMLElement.prototype.scrollTo = function (
    options?: ScrollToOptions | number,
    y?: number
  ) {
    const top = typeof options === "number" ? (y ?? 0) : (options?.top ?? 0);
    if (this.scrollTop === top) return;
    this.scrollTop = top;
    // Native scroll events arrive after layout effects finish.
    queueMicrotask(() => this.dispatchEvent(new Event("scroll")));
  };
  const previousScrollIntoView = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = vi.fn();
  return () => {
    offsetHeight.mockRestore();
    clientHeight.mockRestore();
    offsetWidth.mockRestore();
    scrollHeight.mockRestore();
    HTMLElement.prototype.scrollTo = previousScrollTo;
    HTMLElement.prototype.scrollIntoView = previousScrollIntoView;
  };
}
