/**
 * useCommandMode Hook
 *
 * Command mode shell for EditorPalette. The legacy registry-generated command
 * list has been removed so command entries can be rebuilt from a curated source.
 */
import { useMemo } from "react";

import type { SpotlightItem } from "../../../shared";

interface UseCommandModeOptions {
  enabled: boolean;
}

interface UseCommandModeReturn {
  items: SpotlightItem[];
  isLoading: boolean;
}

export function useCommandMode({
  enabled,
}: UseCommandModeOptions): UseCommandModeReturn {
  const items = useMemo<SpotlightItem[]>(() => {
    if (!enabled) {
      return [];
    }

    return [];
  }, [enabled]);

  return {
    items,
    isLoading: false,
  };
}

export default useCommandMode;
