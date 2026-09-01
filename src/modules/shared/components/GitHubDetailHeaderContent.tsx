import React from "react";

import IntegrationIcon from "@src/components/IntegrationIcon";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";

export interface GitHubDetailHeaderContentProps {
  number?: number;
  title: string;
  status?: React.ReactNode;
}

/** Shared GitHub identity row used by issue and pull-request detail headers. */
const GitHubDetailHeaderContent: React.FC<GitHubDetailHeaderContentProps> = ({
  number,
  title,
  status,
}) => (
  <span className="flex min-w-0 flex-1 items-center gap-2">
    <IntegrationIcon
      type="github"
      size={HEADER_ICON_SIZE.sm}
      className="shrink-0"
    />
    {status}
    {number !== undefined ? (
      <span className="shrink-0 text-[11px] text-text-3 select-text">
        #{number}
      </span>
    ) : null}
    <span
      className="min-w-0 flex-1 truncate text-[13px] font-medium text-text-1 select-text"
      title={title}
    >
      {title}
    </span>
  </span>
);

export default GitHubDetailHeaderContent;
