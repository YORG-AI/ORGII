import type { ReactNode } from "react";

import { HugeiconsIcon, WorkflowCircle05Icon } from "@src/icons";

interface OrgTaskDependencyBadgeProps {
  count: number;
}

export function OrgTaskDependencyBadge({ count }: OrgTaskDependencyBadgeProps) {
  if (count <= 0) return null;

  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-fill-4 px-1.5 py-0.5 text-[10px] text-text-4">
      <HugeiconsIcon
        icon={WorkflowCircle05Icon}
        data-icon="git-branch"
        size={10}
      />{" "}
      {count} deps
    </span>
  );
}

export function OrgTaskMetaRows({ children }: { children: ReactNode }) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-y-0.5 text-[13px] leading-normal [&>*+*]:relative [&>*+*]:ml-2 [&>*+*]:pl-2 [&>*+*]:before:absolute [&>*+*]:before:top-1/2 [&>*+*]:before:left-0 [&>*+*]:before:h-3 [&>*+*]:before:w-px [&>*+*]:before:-translate-y-1/2 [&>*+*]:before:bg-border-1">
      {children}
    </div>
  );
}

export function OrgTaskOwnerChangedBadge() {
  return (
    <span
      className="shrink-0 rounded-full bg-primary-6/10 px-1.5 py-0.5 text-[10px] text-primary-6"
      data-testid="org-task-card-owner-changed"
    >
      owner changed
    </span>
  );
}
