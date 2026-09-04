import type { ReactNode } from "react";

import { SessionRowStatusDot } from "@src/components/SessionRowPresentation";
import { type SessionStatusDotTone } from "@src/util/session/sessionStatusDot";

type StatusDotTone = Extract<
  SessionStatusDotTone,
  "default" | "unread" | "asking"
>;

/**
 * Keep the historical helper name for call-site compatibility. A working
 * session may stay in the sidebar for hours, so its marker must not own a
 * permanent compositor animation. The accessible label still distinguishes
 * working state from the static unread and pending-question markers.
 */
export function renderBreathingStatusDot(): ReactNode {
  return <SessionRowStatusDot tone="working" label="Working" />;
}

export function renderStatusDot(tone: StatusDotTone = "default"): ReactNode {
  const ariaLabel =
    tone === "unread"
      ? "Unread"
      : tone === "asking"
        ? "Pending question"
        : undefined;

  return <SessionRowStatusDot tone={tone} label={ariaLabel} />;
}
