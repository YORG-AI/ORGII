import type { ReactNode } from "react";

import { CODEMIRROR_STYLE_NONCE } from "@src/features/CodeMirror/config/csp";
import type { SessionSidebarStatusTone } from "@src/util/session/sessionSidebarStatusTone";

export type StatusDotTone = SessionSidebarStatusTone;

export function renderBreathingStatusDot(): ReactNode {
  return (
    <span
      aria-label="Working"
      className="h-1.5 w-1.5 rounded-full bg-primary-6 motion-safe:animate-[sidebar-working-dot-breathe_1.6s_ease-in-out_infinite] motion-reduce:opacity-80"
    >
      <style nonce={CODEMIRROR_STYLE_NONCE}>{`
        @keyframes sidebar-working-dot-breathe {
          0%, 100% { opacity: 0.6; transform: scale(0.9); }
          50% { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </span>
  );
}

export function renderStatusDot(tone: StatusDotTone = "default"): ReactNode {
  const ariaLabel =
    tone === "unread"
      ? "Unread"
      : tone === "asking"
        ? "Pending question"
        : tone === "failed"
          ? "Failed"
          : undefined;
  const colorClass =
    tone === "unread"
      ? "bg-success-6"
      : tone === "asking" || tone === "failed"
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
