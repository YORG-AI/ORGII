import {
  Check,
  CheckCircle2,
  CircleDashed,
  CircleSlash,
  Ellipsis,
  LoaderCircle,
  Minus,
  X,
  XCircle,
} from "lucide-react";
import React from "react";

import type { PullRequestCiStatus } from "@src/api/tauri/github";

export interface PrCiStatusIndicatorProps {
  appearance?: "circled" | "simple";
  className?: string;
  dataTestId?: string;
  label: string;
  showLabel?: boolean;
  size?: number;
  status: PullRequestCiStatus;
}

const PrCiStatusIndicator: React.FC<PrCiStatusIndicatorProps> = ({
  appearance = "circled",
  className = "",
  dataTestId,
  label,
  showLabel = true,
  size = 14,
  status,
}) => {
  const iconProps = { size, strokeWidth: 1.8 } as const;
  const icon =
    appearance === "simple" ? (
      status === "success" ? (
        <Check {...iconProps} />
      ) : status === "failure" ? (
        <X {...iconProps} />
      ) : status === "pending" ? (
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-warning-6" />
      ) : status === "none" ? (
        <Minus {...iconProps} />
      ) : (
        <Ellipsis {...iconProps} />
      )
    ) : status === "success" ? (
      <CheckCircle2 {...iconProps} />
    ) : status === "failure" ? (
      <XCircle {...iconProps} />
    ) : status === "pending" ? (
      <LoaderCircle {...iconProps} className="animate-spin" />
    ) : status === "none" ? (
      <CircleSlash {...iconProps} />
    ) : (
      <CircleDashed {...iconProps} />
    );
  const colorClass =
    status === "success"
      ? "text-success-6"
      : status === "failure"
        ? "text-danger-6"
        : status === "pending"
          ? "text-warning-6"
          : "text-text-3";

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap ${colorClass} ${className}`}
      title={label}
      aria-label={label}
      data-testid={dataTestId}
    >
      {icon}
      {showLabel && <span>{label}</span>}
    </span>
  );
};

export default PrCiStatusIndicator;
