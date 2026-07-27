import { useEffect, useRef } from "react";

/** Window in which a second Escape must land to count as a double-press. */
const DOUBLE_PRESS_MS = 400;

/**
 * Triggers `onStop` when the Escape key is pressed twice in quick succession
 * while the chat turn is running. Only active while `enabled` is true.
 *
 * A single Escape is intentionally inert — stopping must be a deliberate
 * double-press so a stray Escape never cancels a running turn. The listener
 * is attached at the document level (and only while enabled) so the shortcut
 * works whether or not the input itself is focused.
 */
export function useStopOnDoubleEscape(
  enabled: boolean,
  onStop: () => void
): void {
  const lastEscapeRef = useRef(0);
  const onStopRef = useRef(onStop);
  useEffect(() => {
    onStopRef.current = onStop;
  }, [onStop]);

  useEffect(() => {
    if (!enabled) {
      lastEscapeRef.current = 0;
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const now = Date.now();
      if (now - lastEscapeRef.current <= DOUBLE_PRESS_MS) {
        lastEscapeRef.current = 0;
        event.preventDefault();
        onStopRef.current();
      } else {
        lastEscapeRef.current = now;
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      lastEscapeRef.current = 0;
    };
  }, [enabled]);
}
