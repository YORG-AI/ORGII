/**
 * BrowseCard — shared clickable row card for browse/discovery lists.
 *
 * Used by Market Agent Apps, Extensions Skills Hub, MCP Hub,
 * and the Open VSX extension market.
 *
 * When `actionButton` is provided the chevron is replaced by the action area
 * and the outer element becomes a `<div>` so the nested button is valid HTML.
 */
import React from "react";

import { ArrowRight01Icon, HugeiconsIcon } from "@src/icons";

export interface BrowseCardProps {
  /** Primary display name */
  title: string;
  /** Secondary text after title (e.g. creator name, version) */
  subtitle?: string;
  /** Longer description below the title row */
  description?: string;
  /** Max lines for description (default 1) */
  descriptionLines?: 1 | 2 | 3;
  /** Optional icon element rendered before the title area */
  icon?: React.ReactNode;
  /** Optional badge element rendered inline after title (e.g. "Installed", "Verified") */
  badge?: React.ReactNode;
  /** Optional metadata row below the description (e.g. stats, price) */
  meta?: React.ReactNode;
  /** Action button rendered on the right — replaces the default chevron */
  actionButton?: React.ReactNode;
  /** Click handler — receives the card id */
  onClick?: () => void;
  /** Additional className on the outer button */
  className?: string;
}

const DESCRIPTION_CLAMP: Record<1 | 2 | 3, string> = {
  1: "line-clamp-1",
  2: "line-clamp-2",
  3: "line-clamp-3",
};

const BrowseCard: React.FC<BrowseCardProps> = ({
  title,
  subtitle,
  description,
  descriptionLines = 1,
  icon,
  badge,
  meta,
  actionButton,
  onClick,
  className = "",
}) => {
  const baseClasses = `group/card relative flex w-full items-start gap-3 rounded-lg bg-fill-2 px-4 py-3 text-left transition-colors hover:bg-fill-2 ${className}`;

  const content = (
    <>
      {icon && <div className="shrink-0">{icon}</div>}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-text-1">
            {title}
          </span>
          {subtitle && (
            <span className="shrink-0 text-xs text-text-3">{subtitle}</span>
          )}
          {badge}
        </div>
        {description && (
          <p
            className={`mt-0.5 ${DESCRIPTION_CLAMP[descriptionLines]} text-xs text-text-3`}
          >
            {description}
          </p>
        )}
        {meta && <div className="mt-1.5">{meta}</div>}
      </div>
      {actionButton ? (
        <div className="shrink-0">{actionButton}</div>
      ) : (
        <HugeiconsIcon
          icon={ArrowRight01Icon}
          data-icon="chevron-right"
          size={14}
          className="absolute top-1/2 right-4 -translate-y-1/2 text-text-2 opacity-0 transition-opacity group-hover/card:opacity-100"
        />
      )}
    </>
  );

  if (actionButton) {
    return (
      <div className={baseClasses} onClick={onClick} role="group">
        {content}
      </div>
    );
  }

  return (
    <button type="button" className={baseClasses} onClick={onClick}>
      {content}
    </button>
  );
};

export default BrowseCard;
