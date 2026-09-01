/**
 * ContentSearchPalette Component
 *
 * Spotlight-style search input for filtering page content. Pure input —
 * the caller filters its own list in real-time. No item list, no footer.
 *
 * @example
 * ```tsx
 * <ContentSearchPalette
 *   isOpen={isSearchOpen}
 *   onClose={() => setIsSearchOpen(false)}
 *   query={searchQuery}
 *   onQueryChange={setSearchQuery}
 *   placeholder="Search projects..."
 * />
 * ```
 */
import React from "react";

import { type BasePaletteProps, SpotlightInput } from "../../shared";
import { SpotlightShell } from "../../shell";
import { useSelectorKernel } from "../core";

// ============ PROPS ============

interface ContentSearchPaletteProps extends BasePaletteProps {
  query: string;
  onQueryChange: (query: string) => void;
  placeholder?: string;
}

// ============ COMPONENT ============

export const ContentSearchPalette: React.FC<ContentSearchPaletteProps> = ({
  isOpen,
  onClose,
  query,
  onQueryChange,
  placeholder = "Search...",
}) => {
  const kernel = useSelectorKernel({
    isOpen,
    onClose,
    items: [],
  });

  return (
    <SpotlightShell isOpen={isOpen} onClose={onClose} hideFooter>
      <SpotlightInput
        inputRef={kernel.inputRef}
        value={query}
        onChange={onQueryChange}
        onKeyDown={kernel.handleKeyDown}
        placeholder={placeholder}
      />
    </SpotlightShell>
  );
};
