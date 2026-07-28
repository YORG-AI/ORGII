export interface FileDropdownPositionOptions {
  triggerRect: Pick<DOMRect, "bottom" | "left">;
  viewportWidth: number;
  viewportHeight: number;
  dropdownWidth: number;
  dropdownMaxHeight: number;
  viewportMargin: number;
  triggerGap: number;
}

export interface FileDropdownPosition {
  top: number;
  left: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Positions the breadcrumb file tree below its active path segment. */
export function calculateFileDropdownPosition({
  triggerRect,
  viewportWidth,
  viewportHeight,
  dropdownWidth,
  dropdownMaxHeight,
  viewportMargin,
  triggerGap,
}: FileDropdownPositionOptions): FileDropdownPosition {
  const maxLeft = Math.max(
    viewportMargin,
    viewportWidth - dropdownWidth - viewportMargin
  );
  const availablePanelHeight = Math.max(0, viewportHeight - viewportMargin * 2);
  const panelHeight = Math.min(dropdownMaxHeight, availablePanelHeight);
  const maxTop = Math.max(
    viewportMargin,
    viewportHeight - panelHeight - viewportMargin
  );

  return {
    top: clamp(triggerRect.bottom + triggerGap, viewportMargin, maxTop),
    left: clamp(triggerRect.left, viewportMargin, maxLeft),
  };
}
