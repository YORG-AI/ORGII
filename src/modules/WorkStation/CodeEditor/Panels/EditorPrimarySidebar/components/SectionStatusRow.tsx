/**
 * SectionStatusRow
 *
 * Shared inline status row used by primary-sidebar section panels
 * (IssuesContent, PullRequestContent, …) to render loading / error / empty
 * state INSIDE the collapsible OPEN/CLOSED structure — not as a centered
 * full-pane Placeholder. See `workspace_sidebar_section_loading_inside_structure`.
 */
import React from "react";

import { HugeiconsIcon, Loading03Icon } from "@src/icons";

export type SectionStatus =
  | { kind: "loading"; message: string }
  | { kind: "error"; message: string }
  | { kind: "empty"; message: string };

export const SectionStatusRow: React.FC<{ status: SectionStatus }> = ({
  status,
}) => {
  if (status.kind === "loading") {
    return (
      <div className="flex items-center gap-1.5 px-3 py-2">
        <HugeiconsIcon
          icon={Loading03Icon}
          data-icon="loader-2"
          size={12}
          className="animate-spin text-text-3"
        />
        <span className="text-[11px] text-text-3">{status.message}</span>
      </div>
    );
  }
  if (status.kind === "error") {
    return (
      <p className="text-text-error px-3 py-2 text-[11px]">{status.message}</p>
    );
  }
  return <p className="px-3 py-2 text-[11px] text-text-3">{status.message}</p>;
};
