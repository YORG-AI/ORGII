/**
 * usePreviewNavigation — generic prev/next navigation for preview panels.
 *
 * Given a list of item keys and the currently selected key,
 * returns callbacks and flags for navigating to the previous/next item.
 */
import { useCallback, useMemo } from "react";

interface UsePreviewNavigationOptions {
  keys: string[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
}

export interface PreviewNavigation {
  /** Both defined when `keys.length > 0` so the header keeps a stable nav width. */
  onPrev: (() => void) | undefined;
  onNext: (() => void) | undefined;
  hasPrev: boolean;
  hasNext: boolean;
}

export function usePreviewNavigation({
  keys,
  selectedKey,
  onSelect,
}: UsePreviewNavigationOptions): PreviewNavigation {
  const selectedIndex = useMemo(() => {
    if (!selectedKey) return -1;
    return keys.indexOf(selectedKey);
  }, [keys, selectedKey]);

  const onPrev = useCallback(() => {
    if (selectedIndex > 0) onSelect(keys[selectedIndex - 1]);
  }, [keys, selectedIndex, onSelect]);

  const onNext = useCallback(() => {
    if (selectedIndex >= 0 && selectedIndex < keys.length - 1)
      onSelect(keys[selectedIndex + 1]);
  }, [keys, selectedIndex, onSelect]);

  const hasPrev = selectedIndex > 0;
  const hasNext = selectedIndex >= 0 && selectedIndex < keys.length - 1;

  if (keys.length === 0) {
    return {
      onPrev: undefined,
      onNext: undefined,
      hasPrev: false,
      hasNext: false,
    };
  }

  return {
    onPrev,
    onNext,
    hasPrev,
    hasNext,
  };
}
