import type { ButtonHTMLAttributes } from "react";

import { BUTTON_SIZE } from "@src/config/workstation/tokens";
import { HugeiconsIcon, Loading03Icon, StopIcon } from "@src/icons";

interface ProcessStopButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children"
> {
  label: string;
  size?: keyof typeof BUTTON_SIZE;
  loading?: boolean;
}

/** Shared process termination affordance, matching the server watcher. */
export function ProcessStopButton({
  label,
  size = "md",
  loading = false,
  disabled,
  className = "",
  onClick,
  ...props
}: ProcessStopButtonProps) {
  return (
    <button
      {...props}
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled || loading}
      className={`hover:text-danger-7 inline-flex shrink-0 items-center justify-center rounded text-danger-6 transition-colors hover:bg-danger-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary-6 disabled:cursor-not-allowed disabled:opacity-40 ${BUTTON_SIZE[size]} ${className}`}
      onClick={(event) => {
        event.stopPropagation();
        onClick?.(event);
      }}
    >
      <HugeiconsIcon
        icon={loading ? Loading03Icon : StopIcon}
        data-icon={loading ? "loader-2" : "stop"}
        size={14}
        aria-hidden
        className={loading ? "animate-spin" : undefined}
      />
    </button>
  );
}
