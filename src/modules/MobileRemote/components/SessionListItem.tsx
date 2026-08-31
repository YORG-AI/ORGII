import React from "react";

import { HugeiconsIcon, PlayIcon } from "@src/icons";

import { LiveCloudBadge } from "./badges/LiveCloudBadge";

export interface SessionListItemProps {
  name: string;
  status: "running" | "idle";
  category?: "live" | "cloud";
  onSelect?: () => void;
}

export function SessionListItem({
  name,
  status,
  category = "live",
  onSelect,
}: SessionListItemProps) {
  return (
    <button
      type="button"
      data-testid="mobile-remote-session-row"
      className="flex min-h-14 w-full cursor-pointer select-none items-center gap-3 rounded-lg border-0 bg-transparent px-3 py-2.5 text-left text-text-2 outline-none transition-[background-color,color,box-shadow] duration-150 hover:bg-surface-hover focus-visible:text-text-1 focus-visible:ring-2 focus-visible:ring-primary-6/30 active:bg-surface-selected"
      onClick={onSelect}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-success-1 text-success-6">
        <HugeiconsIcon icon={PlayIcon} size={12} strokeWidth={2} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-text-1">
          {name}
        </span>
        <span className="block text-xs text-text-3">{status}</span>
      </span>
      {status === "running" ? <LiveCloudBadge category={category} /> : null}
    </button>
  );
}

SessionListItem.displayName = "SessionListItem";
