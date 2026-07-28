// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import ScrollPreservation, {
  type ScrollPreservationProps,
} from "./ScrollPreservation";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function PaginationHarness() {
  const [page, setPage] = useState(1);

  // React's createElement overload does not infer required children from its trailing arguments.
  return createElement(
    ScrollPreservation,
    { id: "scroll-region" } as ScrollPreservationProps,
    createElement(
      "button",
      {
        type: "button",
        onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
          const scrollRegion = event.currentTarget.parentElement;
          if (scrollRegion) scrollRegion.scrollTop = 0;
          setPage((current) => current + 1);
        },
      },
      "Next"
    ),
    createElement("span", null, `Page ${page}`)
  );
}

describe("ScrollPreservation", () => {
  const roots: Array<ReturnType<typeof createRoot>> = [];
  const containers: HTMLElement[] = [];

  afterEach(async () => {
    await act(async () => {
      roots.forEach((root) => root.unmount());
    });
    containers.forEach((container) => container.remove());
    roots.length = 0;
    containers.length = 0;
  });

  it("restores the viewport after a pagination click rerenders its content", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    containers.push(container);

    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(createElement(PaginationHarness)));

    const scrollRegion = container.querySelector<HTMLElement>("#scroll-region");
    const nextButton = container.querySelector<HTMLButtonElement>("button");
    expect(scrollRegion).not.toBeNull();
    expect(nextButton).not.toBeNull();
    if (!scrollRegion || !nextButton) return;

    Object.defineProperties(scrollRegion, {
      scrollHeight: { configurable: true, value: 1_000 },
      clientHeight: { configurable: true, value: 400 },
    });
    scrollRegion.scrollTop = 320;

    await act(async () => {
      nextButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(scrollRegion.scrollTop).toBe(320);
    expect(container.textContent).toContain("Page 2");
  });
});
