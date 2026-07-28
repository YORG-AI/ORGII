import type React from "react";

interface NavigationMenuRowAccessorySlotProps {
  persistentContent?: React.ReactNode;
  hoverContent?: React.ReactNode;
  actionContent?: React.ReactNode;
  /** Bind hover transitions to a parent-row named group. */
  parentHoverGroup?: boolean;
  /**
   * Status indicator (e.g. "working" breathing dot). Rendered in the same
   * grid cell as persistentContent and fades out on hover so that hover-only
   * content (timestamps, actions) can take full visual focus.
   */
  workingIndicatorContent?: React.ReactNode;
}

export function NavigationMenuRowAccessorySlot({
  persistentContent,
  hoverContent,
  actionContent,
  workingIndicatorContent,
  parentHoverGroup = false,
}: NavigationMenuRowAccessorySlotProps): React.ReactElement | null {
  if (
    !persistentContent &&
    !hoverContent &&
    !actionContent &&
    !workingIndicatorContent
  ) {
    return null;
  }

  // Persistent content fades on hover ONLY when hover content replaces it
  // (develop's guard — otherwise it blinks out with nothing in its place);
  // parent thread rows scope the transition to the named group so a nested
  // child's anonymous `group` cannot capture it.
  const hasHoverReplacement = Boolean(hoverContent || actionContent);
  const persistentHoverClasses = !hasHoverReplacement
    ? ""
    : parentHoverGroup
      ? "group-hover/parent:pointer-events-none group-hover/parent:opacity-0"
      : "group-hover:pointer-events-none group-hover:opacity-0";
  const revealedHoverClasses = parentHoverGroup
    ? "group-hover/parent:pointer-events-auto group-hover/parent:max-w-[11rem] group-hover/parent:opacity-100"
    : "group-hover:pointer-events-auto group-hover:max-w-[11rem] group-hover:opacity-100";
  const hasStacked = Boolean(
    persistentContent ||
    hoverContent ||
    actionContent ||
    workingIndicatorContent
  );
  const stackedContent = hasStacked ? (
    <span className="grid items-center justify-end leading-none">
      {/* Both layers share one grid cell and must be `justify-self-end`. The
          cell is as wide as the widest layer, and a stretched item whose
          `max-width` clamps it falls back to *start* alignment — so while the
          reveal animates `max-w-0 → 11rem` the buttons would slide rightwards
          from behind the persistent layer instead of staying put. */}
      {(persistentContent || workingIndicatorContent) && (
        <span
          className={`col-start-1 row-start-1 inline-flex items-center justify-end justify-self-end leading-none transition-opacity duration-150 ${persistentHoverClasses}`}
        >
          {persistentContent}
          {workingIndicatorContent}
        </span>
      )}
      {(hoverContent || actionContent) && (
        <span
          className={`pointer-events-none col-start-1 row-start-1 inline-flex max-w-0 items-center justify-end gap-1.5 justify-self-end overflow-hidden whitespace-nowrap opacity-0 transition-[max-width,opacity] duration-150 ${revealedHoverClasses}`}
        >
          {hoverContent && (
            <span className="inline-flex max-w-[4rem] items-center justify-end overflow-hidden">
              {hoverContent}
            </span>
          )}
          {actionContent && (
            <span className="-mr-0.5 inline-flex items-center justify-end gap-1">
              {actionContent}
            </span>
          )}
        </span>
      )}
    </span>
  ) : null;

  return (
    <span className="ml-1 flex flex-shrink-0 items-center justify-end leading-none">
      {stackedContent}
    </span>
  );
}
