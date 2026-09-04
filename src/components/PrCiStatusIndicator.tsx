import React from "react";

import type { PullRequestCiStatus } from "@src/api/tauri/github";
import {
  Cancel01Icon,
  CancelCircleIcon,
  CheckmarkCircle01Icon,
  CircleDashedIcon,
  CircleSlashIcon,
  EllipsisIcon,
  HugeiconsIcon,
  LoaderCircleIcon,
  MinusSignIcon,
  Tick01Icon,
} from "@src/icons";

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
        <HugeiconsIcon icon={Tick01Icon} data-icon="check" {...iconProps} />
      ) : status === "failure" ? (
        <HugeiconsIcon icon={Cancel01Icon} data-icon="x" {...iconProps} />
      ) : status === "pending" ? (
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
      ) : status === "none" ? (
        <HugeiconsIcon icon={MinusSignIcon} data-icon="minus" {...iconProps} />
      ) : (
        <HugeiconsIcon
          icon={EllipsisIcon}
          data-icon="ellipsis"
          {...iconProps}
        />
      )
    ) : status === "success" ? (
      <HugeiconsIcon
        icon={CheckmarkCircle01Icon}
        data-icon="check-circle-2"
        {...iconProps}
      />
    ) : status === "failure" ? (
      <HugeiconsIcon
        icon={CancelCircleIcon}
        data-icon="xcircle"
        {...iconProps}
      />
    ) : status === "pending" ? (
      <HugeiconsIcon
        icon={LoaderCircleIcon}
        data-icon="loader-circle"
        {...iconProps}
        className="animate-spin"
      />
    ) : status === "none" ? (
      <HugeiconsIcon
        icon={CircleSlashIcon}
        data-icon="circle-slash"
        {...iconProps}
      />
    ) : (
      <HugeiconsIcon
        icon={CircleDashedIcon}
        data-icon="circle-dashed"
        {...iconProps}
      />
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
      role={showLabel ? undefined : "img"}
      data-testid={dataTestId}
    >
      {icon}
      {showLabel && <span>{label}</span>}
    </span>
  );
};

export default PrCiStatusIndicator;
