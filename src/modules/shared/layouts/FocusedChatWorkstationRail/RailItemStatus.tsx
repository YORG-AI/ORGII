/**
 * RailItemStatus — CI badge shown at the end of a rail row (e.g. the PR row).
 */
import { CheckCircle2, CircleSlash, LoaderCircle, XCircle } from "lucide-react";

import type { FocusedChatRailItem } from "./types";

export function RailItemStatus({
  status,
}: {
  status: NonNullable<FocusedChatRailItem["status"]>;
}) {
  const commonProps = {
    "aria-hidden": true,
    className: "shrink-0",
    size: 12,
    strokeWidth: 2,
  } as const;
  const icon =
    status.state === "success" ? (
      <CheckCircle2 {...commonProps} />
    ) : status.state === "failure" ? (
      <XCircle {...commonProps} />
    ) : status.state === "checking" || status.state === "pending" ? (
      <LoaderCircle {...commonProps} className="shrink-0 animate-spin" />
    ) : (
      <CircleSlash {...commonProps} />
    );
  const colorClass =
    status.state === "success"
      ? "text-success-6"
      : status.state === "failure"
        ? "text-danger-6"
        : status.state === "checking" || status.state === "pending"
          ? "text-warning-6"
          : "text-text-3";

  return (
    <span
      className={`flex shrink-0 items-center gap-1 text-[11px] ${colorClass}`}
      title={status.title}
      aria-label={status.title}
    >
      {icon}
      <span>{status.label}</span>
    </span>
  );
}
