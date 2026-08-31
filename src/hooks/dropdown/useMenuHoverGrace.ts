import { useCallback, useEffect, useRef } from "react";

/** Time to cross a gap or an adjacent row on the way into a submenu. */
const MENU_HOVER_GRACE_MS = 350;

/** One replaceable hover transition; explicit clicks/keys should cancel it. */
export function useMenuHoverGrace(
  enabled: boolean,
  delayMs = MENU_HOVER_GRACE_MS
) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visibilityCleanupRef = useRef<(() => void) | null>(null);

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    visibilityCleanupRef.current?.();
    visibilityCleanupRef.current = null;
  }, []);

  const schedule = useCallback(
    (transition: () => void) => {
      cancel();
      if (!enabled || document.hidden) return;
      if (delayMs <= 0) {
        transition();
        return;
      }

      // Nothing is subscribed while idle. Hiding the app discards pointer
      // intent so a throttled timer cannot change a menu on focus return.
      const onVisibilityChange = () => {
        if (document.hidden) cancel();
      };
      document.addEventListener("visibilitychange", onVisibilityChange);
      visibilityCleanupRef.current = () =>
        document.removeEventListener("visibilitychange", onVisibilityChange);
      timerRef.current = setTimeout(() => {
        cancel();
        transition();
      }, delayMs);
    },
    [cancel, delayMs, enabled]
  );

  // Also discard a pending transition when a controlled menu closes,
  // changes trigger mode, becomes disabled, or changes its delay.
  useEffect(() => cancel, [cancel, delayMs, enabled]);

  return { cancel, schedule };
}
