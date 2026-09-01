interface PaletteSearchState {
  isOpen: boolean;
  query: string;
}

export function advancePaletteSearchState(
  previous: PaletteSearchState,
  isOpen: boolean
): PaletteSearchState {
  if (previous.isOpen === isOpen) return previous;
  return {
    isOpen,
    query: isOpen ? "" : previous.query,
  };
}
