/**
 * Minimal React DOM harness for commit-storm smoke tests.
 *
 * The project deliberately doesn't ship @testing-library/react; the existing
 * hook tests mock React itself, which cannot exercise effect scheduling.
 * Render-loop regressions (effect → setState → render → effect → …) only
 * reproduce under a real renderer, so these helpers mount components with
 * react-dom/client in a jsdom environment (`@vitest-environment jsdom` in the
 * test file) and drive time with vitest fake timers.
 */
import { act } from "react";
import type { ReactElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { expect, vi } from "vitest";

// We always wrap updates in act(); this flag makes React flush accordingly
// instead of warning.
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

export interface SmokeRoot {
  container: HTMLElement;
  render(element: ReactElement): Promise<void>;
  unmount(): Promise<void>;
}

/** Mount point wired into jsdom's document so focus() works. */
export function createSmokeRoot(): SmokeRoot {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root: Root | null = null;

  return {
    container,
    render: async (element) => {
      await act(async () => {
        root ??= createRoot(container);
        root.render(element);
      });
    },
    unmount: async () => {
      await act(async () => {
        root?.unmount();
      });
      root = null;
      container.remove();
    },
  };
}

/** Run a state-updating action (e.g. a setState captured from the tree). */
export async function dispatch(action: () => void): Promise<void> {
  await act(async () => {
    action();
  });
}

/**
 * Advance fake time and flush the resulting timers, microtasks, and React
 * work. Requires vi.useFakeTimers() to be active.
 */
export async function settle(ms = 200): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/**
 * Assert the tree is quiescent: with no external input, the commit counter
 * must not advance while fake time passes. A self-sustaining commit loop —
 * the class of bug these smoke tests guard against — keeps it climbing.
 */
export async function expectQuiescent(
  readCommitCount: () => number,
  ms = 300
): Promise<void> {
  const before = readCommitCount();
  await settle(ms);
  expect(readCommitCount()).toBe(before);
}
