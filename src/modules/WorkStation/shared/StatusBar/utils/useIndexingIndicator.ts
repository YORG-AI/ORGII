/**
 * useIndexingIndicator
 *
 * Keeps the workspace indexing indicator visible for a short grace period
 * after indexing finishes, so a fast pass does not flash in and out.
 */
import { useEffect, useState } from "react";

const HIDE_DELAY_MS = 10_000;

export function useIndexingIndicator(isIndexingActive: boolean): boolean {
  const [hideTimerActive, setHideTimerActive] = useState(false);

  useEffect(() => {
    if (!isIndexingActive) return;
    return () => {
      setHideTimerActive(true);
    };
  }, [isIndexingActive]);

  useEffect(() => {
    if (!hideTimerActive) return;
    const timer = setTimeout(() => setHideTimerActive(false), HIDE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [hideTimerActive]);

  return isIndexingActive || hideTimerActive;
}
