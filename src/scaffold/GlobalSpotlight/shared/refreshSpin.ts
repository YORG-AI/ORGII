/**
 * Spotlight refresh spin
 *
 * Shared spin behavior for every pinned "Refresh" action in the spotlight
 * (branches, worktrees, …).
 *
 * A local git refresh usually resolves in a few milliseconds, so binding the
 * animation straight to the in-flight promise makes the icon twitch once and
 * stop — indistinguishable from a dead button. The spin therefore holds for
 * {@link REFRESH_SPIN_MIN_MS} even when the underlying call finishes sooner,
 * and the action stays clickable while it spins.
 */
import {
  type ComponentType,
  createElement,
  useCallback,
  useState,
} from "react";

import { HugeiconsIcon, type IconSvgElement } from "@src/icons";

/** Floor for the refresh animation so a fast refresh still reads as one. */
export const REFRESH_SPIN_MIN_MS = 900;

/** Milliseconds the spin must still run after a refresh took `elapsedMs`. */
export function remainingSpinMs(
  elapsedMs: number,
  minMs: number = REFRESH_SPIN_MIN_MS
): number {
  if (!Number.isFinite(elapsedMs)) return 0;
  return Math.max(0, minMs - Math.max(0, elapsedMs));
}

interface RefreshSpinIconProps {
  size?: number;
  className?: string;
}

interface UseRefreshSpinReturn {
  /** Whether the icon is currently animating. */
  isSpinning: boolean;
  /** Runs the refresh and keeps the icon spinning for the minimum duration. */
  triggerRefresh: () => void;
  /** Refresh icon bound to the current spin state. */
  RefreshIcon: ComponentType<RefreshSpinIconProps>;
}

/**
 * Wraps a refresh callback with the shared minimum-duration spin state and a
 * ready-made icon component for `SpotlightItem.icon`.
 */
export function useRefreshSpin(
  icon: IconSvgElement,
  refresh: () => void | Promise<unknown>
): UseRefreshSpinReturn {
  const [isSpinning, setIsSpinning] = useState(false);

  const triggerRefresh = useCallback(() => {
    setIsSpinning(true);
    const startedAt = Date.now();
    void Promise.resolve()
      .then(refresh)
      .catch(() => {})
      .finally(() => {
        window.setTimeout(
          () => setIsSpinning(false),
          remainingSpinMs(Date.now() - startedAt)
        );
      });
  }, [refresh]);

  const RefreshIcon = useCallback(
    (props: RefreshSpinIconProps) =>
      createElement(HugeiconsIcon, {
        icon,
        ...props,
        className:
          `${props.className ?? ""} ${isSpinning ? "spotlight-refresh-spin" : ""}`.trim(),
      }),
    [icon, isSpinning]
  );

  return { isSpinning, triggerRefresh, RefreshIcon };
}
