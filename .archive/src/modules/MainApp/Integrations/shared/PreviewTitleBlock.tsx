/**
 * PreviewTitleBlock — reusable icon + title + subtitle block for preview panels.
 *
 * Used in Model, Account, CLI, and Skill previews.
 * 2px gap between title and subtitle; icon on the left.
 */
import React from "react";

export interface PreviewTitleBlockProps {
  icon?: React.ReactNode;
  title: string;
  subtitle?: React.ReactNode;
}

export const PreviewTitleBlock: React.FC<PreviewTitleBlockProps> = ({
  icon,
  title,
  subtitle,
}) => (
  <div className="mb-3 flex items-center gap-3">
    {icon != null && <div className="flex shrink-0 items-center">{icon}</div>}
    <div className="flex min-w-0 flex-1 flex-col leading-none">
      <h3 className="m-0 text-[14px] font-semibold text-text-1">{title}</h3>
      {subtitle != null && (
        <span className="mt-1 text-[12px] text-text-3">{subtitle}</span>
      )}
    </div>
  </div>
);
