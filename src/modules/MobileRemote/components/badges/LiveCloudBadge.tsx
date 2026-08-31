import React from "react";

import Tag from "@src/components/Tag";

export type LiveCloudCategory = "live" | "cloud";

export interface LiveCloudBadgeProps {
  category: LiveCloudCategory;
}

const TONE: Record<LiveCloudCategory, "success" | "processing"> = {
  live: "success",
  cloud: "processing",
};

const LABEL: Record<LiveCloudCategory, string> = {
  live: "LIVE",
  cloud: "CLOUD",
};

export function LiveCloudBadge({ category }: LiveCloudBadgeProps) {
  return (
    <Tag color={TONE[category]} size="small">
      {LABEL[category]}
    </Tag>
  );
}

LiveCloudBadge.displayName = "LiveCloudBadge";
