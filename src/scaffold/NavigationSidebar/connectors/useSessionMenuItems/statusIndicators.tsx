import type { ReactNode } from "react";

import { CODEMIRROR_STYLE_NONCE } from "@src/features/CodeMirror/config/nonce";

export type StatusDotTone = "default" | "unread" | "asking";
export type SessionStatusDotTone = "active" | "completed" | "error";

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

/** Persistent session-state marker used at the end of every session row. */
export function renderSessionStatusDot(tone: SessionStatusDotTone): ReactNode {
  const ariaLabel =
    tone === "active" ? "Active" : tone === "completed" ? "Completed" : "Error";
  const colorClass =
    tone === "active"
      ? "bg-primary-6"
      : tone === "completed"
        ? "bg-success-6"
        : "bg-danger-6";
  return (
    <span
      aria-label={ariaLabel}
      className={`h-1.5 w-1.5 rounded-full ${colorClass}`}
    />
  );
}
