import type { ReactNode } from "react";

export type StatusDotTone = "default" | "unread" | "asking";

/**
 * Keep the historical helper name for call-site compatibility. A working
 * session may stay in the sidebar for hours, so its marker must not own a
 * permanent compositor animation. The accessible label still distinguishes
 * working state from the static unread and pending-question markers.
 */
export function renderBreathingStatusDot(): ReactNode {
  return (
    <span
      aria-label="Working"
      className="h-1.5 w-1.5 rounded-full bg-primary-6 opacity-90"
    />
  );
}

export function renderStatusDot(tone: StatusDotTone = "default"): ReactNode {
  const ariaLabel =
    tone === "unread"
      ? "Unread"
      : tone === "asking"
        ? "Pending question"
        : undefined;
  const colorClass =
    tone === "unread"
      ? "bg-success-6"
      : tone === "asking"
        ? "bg-warning-6"
        : "bg-fill-4";

  return (
    <span
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
      className={`h-1.5 w-1.5 rounded-full ${colorClass}`}
    />
  );
}
