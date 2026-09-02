export interface TabLabelRowScrimProps {
  /** When true, the mounted scrim fades in (e.g. tab hovered and close is available). */
  visible: boolean;
}

/**
 * Right-edge gradient over the label row so title/badge text does not show through
 * the absolute close control when the tab is hovered.
 */
export function TabLabelRowScrim({ visible }: TabLabelRowScrimProps) {
  return (
    <div
      className={`pointer-events-none absolute inset-y-0 right-0 z-2 w-20 bg-linear-to-l from-fill-2 to-transparent transition-opacity duration-150 ${
        visible ? "opacity-100" : "opacity-0"
      }`}
      aria-hidden
    />
  );
}
