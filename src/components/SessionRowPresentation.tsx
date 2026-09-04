import React from "react";

import AnyIcon, { type AnyIconSource } from "@src/components/AnyIcon";
import {
  type SessionStatusDotTone,
  resolveSessionStatusDotColor,
} from "@src/util/session/sessionStatusDot";

/**
 * Browser-safe presentation tokens shared by Desktop sidebar session rows and
 * the Mobile Remote session list. Keep interaction state at each call site;
 * geometry and typography belong here so the two surfaces cannot drift.
 */
export const SESSION_ROW_PRESENTATION = {
  row: "flex h-8 items-center justify-between overflow-hidden rounded-lg transition-colors duration-150",
  content: "flex min-w-0 flex-1 items-center gap-3",
  leadingIcon:
    "relative inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center leading-none",
  text: "flex min-w-0 flex-1 flex-col gap-0",
  title: "min-w-0 truncate text-[13px] leading-4",
  subtitle:
    "flex min-w-0 items-center gap-1 truncate text-[11px] leading-3 text-text-3",
} as const;

interface SessionRowStatusDotProps {
  tone?: SessionStatusDotTone;
  label?: string;
}

export function SessionRowStatusDot({
  tone = "default",
  label,
}: SessionRowStatusDotProps): React.ReactElement {
  return (
    <span
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={`h-1.5 w-1.5 rounded-full ${
        tone === "working" ? "opacity-90" : ""
      }`.trim()}
      style={{ backgroundColor: resolveSessionStatusDotColor(tone) }}
    />
  );
}

interface SessionRowLeadingIconProps {
  icon: AnyIconSource | undefined | null;
  iconLabel: string;
  statusTone?: SessionStatusDotTone;
  statusLabel?: string;
  iconClassName?: string;
}

export function SessionRowLeadingIcon({
  icon,
  iconLabel,
  statusTone,
  statusLabel,
  iconClassName = "text-text-2",
}: SessionRowLeadingIconProps): React.ReactElement {
  return (
    <span className={SESSION_ROW_PRESENTATION.leadingIcon}>
      <AnyIcon
        icon={icon}
        data-icon={iconLabel}
        size={14}
        strokeWidth={2}
        className={`shrink-0 ${iconClassName}`}
        aria-hidden
      />
      {statusTone ? (
        <span className="pointer-events-none absolute -right-0.5 -bottom-0.5 inline-flex rounded-full bg-bg-1 ring-1 ring-bg-1">
          <SessionRowStatusDot tone={statusTone} label={statusLabel} />
        </span>
      ) : null}
    </span>
  );
}
