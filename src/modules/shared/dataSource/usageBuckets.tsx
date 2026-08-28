import React from "react";

import type { UsageBucket } from "@src/api/tauri/usageDashboard";
import ModelIcon, { type IconProvider } from "@src/components/ModelIcon";
import { BoxesIcon, HugeiconsIcon } from "@src/icons";

/**
 * Visual metadata for the four source buckets the Usage dashboard scopes to —
 * each reuses a shared brand icon (`org2` = the ORGII mark). Unknown buckets
 * fall back to a neutral glyph.
 */
const BUCKET_ICON_PROVIDER: Partial<Record<UsageBucket, IconProvider>> = {
  claude: "claude",
  codex: "codex",
  cursor: "cursor",
  org2: "orgii",
};

/** i18n key suffix under `kanban.dataSource.usage.bucket.*`. */
export function bucketLabelKey(bucket: string): string {
  return `usage.bucket.${bucket}`;
}

interface BucketIconProps {
  bucket: string;
  size?: number;
  className?: string;
}

/** Icon for a source bucket, brand mark where one exists. */
export const BucketIcon: React.FC<BucketIconProps> = ({
  bucket,
  size = 14,
  className,
}) => {
  const provider = BUCKET_ICON_PROVIDER[bucket as UsageBucket];
  if (provider) {
    return <ModelIcon provider={provider} size={size} className={className} />;
  }
  return (
    <HugeiconsIcon
      icon={BoxesIcon}
      data-icon="boxes"
      size={size}
      className={className}
    />
  );
};
